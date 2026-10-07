/**
 * 管理接口：单用户账单动作（充值、调整、对账、流水、用量）。
 *
 * 从 adminUsers.ts 拆出（架构 max-lines 约束）：这些路由只消费 BillingService，
 * 与账号本身的增删改完全正交。金额一律十进制字符串进出（如 "12.5"），
 * 服务端转整数微元——避免浮点进入记账链路。
 * 审计动作：user.recharge / user.adjust。
 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { BillingService } from "../../../app/billingService.js";
import type { OperationsService } from "../../../app/operationsService.js";
import type { AuthenticatedContext } from "../../../app/ports.js";
import { PlatformError } from "../../../domain/errors.js";
import { formatMicros, microsFromDecimalString, type Micros } from "../../../domain/money.js";
import { toPublicUser } from "../../../domain/user.js";
import { readJsonObject, readString } from "../helpers.js";
import {
  createAdminGuard,
  readPagination,
  readSinceDays,
  type AdminResolver,
} from "./adminSupport.js";

function parseAmount(raw: string, label: string): Micros {
  try {
    return microsFromDecimalString(raw);
  } catch (error) {
    throw new PlatformError("invalid_request", `${label}格式不正确：${raw}`, { cause: error });
  }
}

export function createAdminUserBillingRoutes(deps: {
  readonly accounts: AccountService;
  readonly billing: BillingService;
  readonly operations: OperationsService;
}): Hono {
  const routes = new Hono();
  const requireAdmin: AdminResolver = createAdminGuard(deps.accounts);

  /** 与 adminUsers 相同的审计旁路：record 内部吞异常。 */
  const audit = (
    admin: AuthenticatedContext,
    action: string,
    targetId: string,
    detail: Record<string, unknown> | null,
  ): void => {
    deps.operations.record({
      actorUserId: admin.user.id,
      action,
      targetType: "user",
      targetId,
      detail: detail === null ? null : JSON.stringify(detail),
      now: Date.now(),
    });
  };

  /** 充值/调整后的回显：管理页需要立刻看到新余额。 */
  const summarize = async (userId: string) => {
    const [user, summary] = await Promise.all([
      deps.accounts.getUser(userId),
      deps.billing.getSummary(userId),
    ]);
    return {
      ...toPublicUser(user),
      balanceMicros: summary.balanceMicros,
      availableMicros: summary.availableMicros,
      planName: summary.plan?.name ?? null,
      planRemainingMicros: summary.subscription?.remainingMicros ?? null,
    };
  };

  routes.post("/users/:id/recharge", async (context) => {
    const admin = await requireAdmin(context);
    const userId = context.req.param("id");
    await deps.accounts.getUser(userId);
    const body = await readJsonObject(context);
    const amountMicros = parseAmount(
      readString(body, "amount", { required: true, maxLength: 32, label: "充值金额" }),
      "充值金额",
    );
    if (amountMicros <= 0) {
      throw new PlatformError("invalid_request", "充值金额必须大于 0");
    }
    await deps.billing.recharge({
      userId,
      amountMicros,
      note: readString(body, "note", { maxLength: 200 }) || null,
      createdBy: admin.user.id,
    });
    audit(admin, "user.recharge", userId, { amount: formatMicros(amountMicros) });
    return context.json({ user: await summarize(userId) });
  });

  routes.post("/users/:id/adjust", async (context) => {
    const admin = await requireAdmin(context);
    const userId = context.req.param("id");
    await deps.accounts.getUser(userId);
    const body = await readJsonObject(context);
    const raw = readString(body, "delta", { required: true, maxLength: 32, label: "调整金额" });
    const positive = !raw.trim().startsWith("-");
    const magnitude = parseAmount(positive ? raw : raw.trim().slice(1), "调整金额");
    if (magnitude === 0) {
      throw new PlatformError("invalid_request", "调整金额必须非零");
    }
    const deltaMicros = positive ? magnitude : -magnitude;
    await deps.billing.adjust({
      userId,
      deltaMicros,
      note: readString(body, "note", { maxLength: 200 }) || null,
      createdBy: admin.user.id,
    });
    audit(admin, "user.adjust", userId, {
      delta: formatMicros(magnitude),
      direction: positive ? "credit" : "debit",
    });
    return context.json({ user: await summarize(userId) });
  });

  routes.get("/users/:id/ledger", async (context) => {
    await requireAdmin(context);
    const { limit, offset } = readPagination(context);
    const result = await deps.billing.listLedger({
      userId: context.req.param("id"),
      limit,
      offset,
    });
    return context.json({
      entries: result.entries.map((entry) => ({
        ...entry,
        amount: formatMicros(Math.abs(entry.amountMicros)),
        direction: entry.amountMicros >= 0 ? "credit" : "debit",
      })),
      total: result.total,
      limit,
      offset,
    });
  });

  routes.get("/users/:id/reconcile", async (context) => {
    await requireAdmin(context);
    const result = await deps.billing.reconcileBalance(context.req.param("id"));
    return context.json({
      storedMicros: result.stored,
      recomputedMicros: result.recomputed,
      driftMicros: result.drift,
      consistent: result.drift === 0,
    });
  });

  routes.get("/users/:id/usage", async (context) => {
    await requireAdmin(context);
    const userId = context.req.param("id");
    const { limit, offset } = readPagination(context);
    const since = readSinceDays(context);
    const [page, totals] = await Promise.all([
      deps.billing.listUsage({
        userId,
        limit,
        offset,
        ...(since !== undefined ? { since } : {}),
      }),
      deps.billing.getUsageTotals({ userId, ...(since !== undefined ? { since } : {}) }),
    ]);
    return context.json({ records: page.records, total: page.total, totals, limit, offset });
  });

  return routes;
}
