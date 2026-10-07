/**
 * 预扣与结算的原子事务（审计#6/#7/#8）。
 *
 * 这些用例直接在仓储层驱动原子方法：并发预扣、结算失败回滚、套餐优先与真实余额封顶。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformRuntime } from "../src/adapters/composition.js";
import { microsFromDecimalString } from "../src/domain/money.js";
import { createTestRuntime } from "./helpers.js";

async function createRuntime(): Promise<{ runtime: PlatformRuntime; userId: string }> {
  const runtime = await createTestRuntime();
  const user = await runtime.accounts.createUser({
    email: "atomic@example.com",
    password: "initial-password",
  });
  return { runtime, userId: user.id };
}

function reservation(
  userId: string,
  requestId: string,
  costMicros: number,
): Parameters<PlatformRuntime["repositories"]["usage"]["reserveForRequest"]>[0] {
  return {
    requestId,
    userId,
    providerId: "anthropic",
    modelId: "claude-test",
    costMicros,
    httpStatus: null,
    durationMs: null,
    now: Date.now(),
  };
}

test("reserveForRequest：并发预扣只放行一笔，重复 request id 返回 duplicate（审计#7）", async () => {
  const { runtime, userId } = await createRuntime();
  try {
    await runtime.billing.recharge({ userId, amountMicros: 100 });
    const [first, second] = await Promise.all([
      runtime.repositories.usage.reserveForRequest(reservation(userId, "req-1", 60)),
      runtime.repositories.usage.reserveForRequest(reservation(userId, "req-2", 60)),
    ]);
    assert.deepEqual([first, second].sort(), ["insufficient_balance", "reserved"]);
    // 只写入了一笔预扣，额度没有被两笔同时占用
    assert.equal(await runtime.repositories.usage.sumReservedMicros(userId), 60);

    const duplicate = await runtime.repositories.usage.reserveForRequest(
      reservation(userId, "req-1", 60),
    );
    assert.equal(duplicate, "duplicate");
    assert.equal(await runtime.repositories.usage.sumReservedMicros(userId), 60);
  } finally {
    runtime.dispose();
  }
});

test("reserveForRequest：余额为 0 但有有效订阅时可以预扣（审计#5）", async () => {
  const { runtime, userId } = await createRuntime();
  try {
    const now = Date.now();
    await runtime.repositories.plans.upsertPlan({
      id: "plan-1",
      name: "套餐",
      quotaMicros: 1_000,
      durationDays: null,
      allowedModels: [],
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.plans.upsertSubscription({
      id: "sub-1",
      userId,
      planId: "plan-1",
      remainingMicros: 500,
      startsAt: 0,
      expiresAt: null,
      revokedAt: null,
      createdAt: now,
    });
    const outcome = await runtime.repositories.usage.reserveForRequest(
      reservation(userId, "req-plan", 400),
    );
    assert.equal(outcome, "reserved");
  } finally {
    runtime.dispose();
  }
});

test("settleWithBilling：流水写入失败时整体回滚，记录保持 reserved（审计#6）", async () => {
  const { runtime, userId } = await createRuntime();
  try {
    await runtime.billing.recharge({ userId, amountMicros: 1_000_000 });
    await runtime.repositories.usage.insertReservation({
      requestId: "req-rollback",
      userId,
      providerId: "anthropic",
      modelId: "claude-test",
      costMicros: 500,
      httpStatus: null,
      durationMs: null,
      now: Date.now(),
    });
    // 预先占用 ledger 的 request_id 幂等键，让结算里的流水写入必然冲突。
    await runtime.repositories.billing.applyLedger({
      userId,
      amountMicros: 1,
      kind: "adjustment",
      requestId: "req-rollback",
      now: Date.now(),
    });
    const balanceBefore = await runtime.repositories.billing.getBalance(userId);

    await assert.rejects(
      runtime.repositories.usage.settleWithBilling({
        requestId: "req-rollback",
        userId,
        usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costMicros: 700,
        status: "ok",
        httpStatus: 200,
        errorMessage: null,
        now: Date.now(),
      }),
    );

    // 状态没有被改成终态，预扣金额也没被覆盖：整笔事务回滚，可被滞留预扣释放兜底。
    const record = await runtime.repositories.usage.findById("req-rollback");
    assert.equal(record?.status, "reserved");
    assert.equal(record?.costMicros, 500);
    assert.equal(record?.usage.inputTokens, 0);
    assert.equal(await runtime.repositories.billing.getBalance(userId), balanceBefore);
  } finally {
    runtime.dispose();
  }
});

test("settleWithBilling：套餐优先，余额用真实余额封顶并记 shortfall（审计#8）", async () => {
  const { runtime, userId } = await createRuntime();
  try {
    await runtime.billing.recharge({ userId, amountMicros: microsFromDecimalString("10") });
    const now = Date.now();
    await runtime.repositories.plans.upsertPlan({
      id: "plan-cap",
      name: "套餐",
      quotaMicros: microsFromDecimalString("5"),
      durationDays: null,
      allowedModels: [],
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.plans.upsertSubscription({
      id: "sub-cap",
      userId,
      planId: "plan-cap",
      remainingMicros: microsFromDecimalString("5"),
      startsAt: 0,
      expiresAt: null,
      revokedAt: null,
      createdAt: now,
    });
    await runtime.repositories.usage.insertReservation({
      requestId: "req-cap",
      userId,
      providerId: "anthropic",
      modelId: "claude-test",
      costMicros: 15_000,
      httpStatus: null,
      durationMs: null,
      now: Date.now(),
    });

    const outcome = await runtime.repositories.usage.settleWithBilling({
      requestId: "req-cap",
      userId,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costMicros: microsFromDecimalString("18"),
      status: "ok",
      httpStatus: 200,
      errorMessage: null,
      now: Date.now(),
    });

    // 套餐 5 元全部抵扣，余额只扣真实拥有的 10 元，差额 3 元是平台承担的部分
    assert.deepEqual(outcome, {
      settled: true,
      fromPlanMicros: microsFromDecimalString("5"),
      fromBalanceMicros: microsFromDecimalString("10"),
      shortfallMicros: microsFromDecimalString("3"),
    });
    assert.equal(await runtime.repositories.billing.getBalance(userId), 0);
    assert.equal(
      (await runtime.repositories.plans.findSubscription("sub-cap"))?.remainingMicros,
      0,
    );
    const ledger = await runtime.repositories.billing.listLedger({
      userId,
      limit: 10,
      offset: 0,
    });
    const usageEntry = ledger.find((entry) => entry.kind === "usage");
    assert.equal(usageEntry?.amountMicros, -microsFromDecimalString("10"));
    assert.match(String(usageEntry?.note), /超出余额/);
    // 流水恒等式仍然成立
    assert.equal(await runtime.repositories.billing.recomputeBalance(userId), 0);
  } finally {
    runtime.dispose();
  }
});

test("settleWithBilling：重复结算返回 settled=false 且不重复记账（审计#6）", async () => {
  const { runtime, userId } = await createRuntime();
  try {
    await runtime.billing.recharge({ userId, amountMicros: 1_000_000 });
    await runtime.repositories.usage.insertReservation({
      requestId: "req-idempotent",
      userId,
      providerId: "anthropic",
      modelId: "claude-test",
      costMicros: 100,
      httpStatus: null,
      durationMs: null,
      now: Date.now(),
    });
    const settlement = {
      requestId: "req-idempotent",
      userId,
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costMicros: 100,
      status: "ok" as const,
      httpStatus: 200,
      errorMessage: null,
      now: Date.now(),
    };
    const first = await runtime.repositories.usage.settleWithBilling(settlement);
    assert.equal(first.settled, true);
    const balanceAfterFirst = await runtime.repositories.billing.getBalance(userId);

    const second = await runtime.repositories.usage.settleWithBilling(settlement);
    assert.deepEqual(second, {
      settled: false,
      fromPlanMicros: 0,
      fromBalanceMicros: 0,
      shortfallMicros: 0,
    });
    assert.equal(await runtime.repositories.billing.getBalance(userId), balanceAfterFirst);
  } finally {
    runtime.dispose();
  }
});
