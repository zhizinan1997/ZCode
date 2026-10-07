/**
 * 余额、流水与用量查询用例。
 *
 * 计费口径（与 specs/platform/gateway-billing.md 一致）：
 * 一次调用的费用先扣套餐额度，额度不足的部分再扣余额。
 * ledger 只记录**余额**的变化，套餐消耗记在 subscriptions.remaining_micros 上；
 * 因此恒等式是 `SUM(ledger.amount) === balances.balance_micros`，可随时对账。
 * 调用的实际结算（改状态 + 扣套餐 + 记流水 + 余额封顶）由 usageRepo.settleWithBilling
 * 在单个事务里完成（审计#6），本服务只负责查询、充值、调整与展示。
 */
import type { LedgerEntry, LedgerKind, UsageRecord, UsageStatus } from "../domain/billing.js";
import { resolveAvailableMicros } from "../domain/billing.js";
import type { Micros } from "../domain/money.js";
import type { PlanRecord, SubscriptionRecord } from "../domain/plans.js";
import { isModelAllowedByPlan, pickActiveSubscription } from "../domain/plans.js";
import { PlatformError } from "../domain/errors.js";
import type {
  BillingRepository,
  LedgerMutation,
  PlanRepository,
  UsageRecordQuery,
  UsageRepository,
  UsageTotals,
} from "./ports.js";

export interface AccountSummary {
  readonly userId: string;
  readonly balanceMicros: Micros;
  readonly reservedMicros: Micros;
  readonly availableMicros: Micros;
  readonly subscription: SubscriptionRecord | null;
  readonly plan: PlanRecord | null;
}

export interface BillingService {
  getSummary(userId: string): Promise<AccountSummary>;
  /**
   * 可用额度 = 余额 − 未结算预扣 + 有效订阅剩余（审计#5）。
   * 展示用它；网关准入的同一口径实现在 sqlite 的原子预扣事务里（usageAtomicRepo）。
   */
  getAvailableMicros(userId: string): Promise<Micros>;
  recharge(input: {
    userId: string;
    amountMicros: Micros;
    note?: string | null;
    createdBy?: string | null;
  }): Promise<void>;
  adjust(input: {
    userId: string;
    /** 可正可负；负数表示人工扣减。 */
    deltaMicros: number;
    note?: string | null;
    createdBy?: string | null;
  }): Promise<void>;
  listLedger(options: { userId?: string; limit: number; offset: number }): Promise<{
    entries: LedgerEntry[];
    total: number;
  }>;
  /** 概览页"今日充值"：按类型与起始时间汇总流水金额（只读）。 */
  sumLedgerSince(options: { kinds: LedgerKind[]; since: number }): Promise<Micros>;
  /** 概览页"平台负债"：全部用户余额合计（只读）。 */
  sumBalances(): Promise<Micros>;
  getActivePlan(
    userId: string,
  ): Promise<{ subscription: SubscriptionRecord; plan: PlanRecord } | null>;
  /** 套餐是否允许该模型；没有生效套餐时不限制。 */
  assertModelEntitled(input: { userId: string; modelId: string | null }): Promise<void>;
  listUsage(query: UsageRecordQuery): Promise<{ records: UsageRecord[]; total: number }>;
  getUsageTotals(query: Omit<UsageRecordQuery, "limit" | "offset">): Promise<UsageTotals>;
  /** 对账：用流水重算余额，返回差异（0 表示一致）。 */
  reconcileBalance(userId: string): Promise<{ stored: Micros; recomputed: Micros; drift: Micros }>;
}

export function createBillingService(deps: {
  readonly billing: BillingRepository;
  readonly usage: UsageRepository;
  readonly plans: PlanRepository;
  readonly now: () => number;
}): BillingService {
  async function resolveSummary(userId: string): Promise<AccountSummary> {
    const [balanceMicros, reservedMicros, subscriptions, plans] = await Promise.all([
      deps.billing.getBalance(userId),
      deps.usage.sumReservedMicros(userId),
      deps.plans.listSubscriptions(userId),
      deps.plans.listPlans(),
    ]);
    const planById = new Map(plans.map((plan) => [plan.id, plan]));
    const active =
      pickActiveSubscription(
        subscriptions
          .map((subscription) => {
            const plan = planById.get(subscription.planId);
            return plan ? { subscription, plan } : null;
          })
          .filter(
            (item): item is { subscription: SubscriptionRecord; plan: PlanRecord } => item !== null,
          ),
        deps.now(),
      ) ?? null;

    return {
      userId,
      balanceMicros,
      reservedMicros,
      // 审计#5：可用额度把有效订阅的剩余额度算进去，余额为 0 的套餐用户不是"不可用"。
      availableMicros: resolveAvailableMicros(
        balanceMicros,
        reservedMicros,
        active?.subscription.remainingMicros ?? 0,
      ),
      subscription: active?.subscription ?? null,
      plan: active?.plan ?? null,
    };
  }

  async function applyLedger(mutation: LedgerMutation): Promise<void> {
    await deps.billing.applyLedger(mutation);
  }

  /** 当前有效订阅与套餐（同时只有一个生效）；展示与权限判定共用一处口径。 */
  async function resolveActivePlan(
    userId: string,
  ): Promise<{ subscription: SubscriptionRecord; plan: PlanRecord } | null> {
    const [subscriptions, plans] = await Promise.all([
      deps.plans.listSubscriptions(userId),
      deps.plans.listPlans(),
    ]);
    const planById = new Map(plans.map((plan) => [plan.id, plan]));
    return pickActiveSubscription(
      subscriptions
        .map((subscription) => {
          const plan = planById.get(subscription.planId);
          return plan ? { subscription, plan } : null;
        })
        .filter(
          (item): item is { subscription: SubscriptionRecord; plan: PlanRecord } => item !== null,
        ),
      deps.now(),
    );
  }

  return {
    getSummary: resolveSummary,

    async getAvailableMicros(userId) {
      const [balance, reserved, active] = await Promise.all([
        deps.billing.getBalance(userId),
        deps.usage.sumReservedMicros(userId),
        resolveActivePlan(userId),
      ]);
      return resolveAvailableMicros(balance, reserved, active?.subscription.remainingMicros ?? 0);
    },

    async recharge({ userId, amountMicros, note, createdBy }) {
      if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
        throw new PlatformError("invalid_request", "充值金额必须是正整数微元");
      }
      await applyLedger({
        userId,
        amountMicros,
        kind: "recharge",
        note: note ?? null,
        createdBy: createdBy ?? null,
        now: deps.now(),
      });
    },

    async adjust({ userId, deltaMicros, note, createdBy }) {
      if (!Number.isSafeInteger(deltaMicros) || deltaMicros === 0) {
        throw new PlatformError("invalid_request", "调整金额必须是非零整数微元");
      }
      await applyLedger({
        userId,
        amountMicros: deltaMicros,
        kind: "adjustment",
        note: note ?? null,
        createdBy: createdBy ?? null,
        now: deps.now(),
      });
    },

    async listLedger({ userId, limit, offset }) {
      const [entries, total] = await Promise.all([
        deps.billing.listLedger({ ...(userId ? { userId } : {}), limit, offset }),
        deps.billing.countLedger(userId),
      ]);
      return { entries, total };
    },

    async sumLedgerSince(options) {
      return await deps.billing.sumLedgerSince(options);
    },

    async sumBalances() {
      return await deps.billing.sumBalances();
    },

    async getActivePlan(userId) {
      return await resolveActivePlan(userId);
    },

    async assertModelEntitled({ userId, modelId }) {
      const active = await resolveActivePlan(userId);
      if (!active || !modelId) {
        return;
      }
      if (!isModelAllowedByPlan(active.subscription, active.plan, modelId)) {
        throw new PlatformError("model_not_entitled", `当前套餐不包含模型 ${modelId}`);
      }
    },

    async listUsage(query) {
      const [records, total] = await Promise.all([
        deps.usage.list(query),
        deps.usage.count({
          ...(query.userId ? { userId: query.userId } : {}),
          ...(query.since !== undefined ? { since: query.since } : {}),
        }),
      ]);
      return { records, total };
    },

    async getUsageTotals(query) {
      return await deps.usage.totals(query);
    },

    async reconcileBalance(userId) {
      const [stored, recomputed] = await Promise.all([
        deps.billing.getBalance(userId),
        deps.billing.recomputeBalance(userId),
      ]);
      return { stored, recomputed, drift: stored - recomputed };
    },
  };
}

export type { UsageStatus };
