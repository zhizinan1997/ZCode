/**
 * 余额、流水与用量查询用例。
 *
 * 计费口径（与 specs/platform/gateway-billing.md 一致）：
 * 一次调用的费用先扣套餐额度，额度不足的部分再扣余额。
 * ledger 只记录**余额**的变化，套餐消耗记在 subscriptions.remaining_micros 上；
 * 因此恒等式是 `SUM(ledger.amount) === balances.balance_micros`，可随时对账。
 */
import type { LedgerEntry, UsageRecord, UsageStatus } from "../domain/billing.js";
import { resolveAvailableMicros } from "../domain/billing.js";
import { formatMicros, type Micros } from "../domain/money.js";
import type { PlanRecord, SubscriptionRecord } from "../domain/plans.js";
import { isSubscriptionActive, isModelAllowedByPlan, pickActiveSubscription } from "../domain/plans.js";
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
  /** 可用余额；网关的准入判定用它。 */
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
  /**
   * 结算一次调用的费用：先扣套餐额度，剩余部分扣余额并写流水。
   * 余额不足时按可用余额封顶，`shortfallMicros` 是平台承担的差额（预付费无法事后追缴）。
   */
  chargeUsage(input: {
    userId: string;
    requestId: string;
    costMicros: Micros;
  }): Promise<{ fromPlanMicros: Micros; fromBalanceMicros: Micros; shortfallMicros: Micros }>;
  getActivePlan(userId: string): Promise<{ subscription: SubscriptionRecord; plan: PlanRecord } | null>;
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
          .filter((item): item is { subscription: SubscriptionRecord; plan: PlanRecord } => item !== null),
        deps.now(),
      ) ?? null;

    return {
      userId,
      balanceMicros,
      reservedMicros,
      availableMicros: resolveAvailableMicros(balanceMicros, reservedMicros),
      subscription: active?.subscription ?? null,
      plan: active?.plan ?? null,
    };
  }

  async function applyLedger(mutation: LedgerMutation): Promise<void> {
    await deps.billing.applyLedger(mutation);
  }

  return {
    getSummary: resolveSummary,

    async getAvailableMicros(userId) {
      const [balance, reserved] = await Promise.all([
        deps.billing.getBalance(userId),
        deps.usage.sumReservedMicros(userId),
      ]);
      return resolveAvailableMicros(balance, reserved);
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

    async getActivePlan(userId) {
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
          .filter((item): item is { subscription: SubscriptionRecord; plan: PlanRecord } => item !== null),
        deps.now(),
      );
    },

    async assertModelEntitled({ userId, modelId }) {
      const active = await this.getActivePlan(userId);
      if (!active || !modelId) {
        return;
      }
      if (!isModelAllowedByPlan(active.subscription, active.plan, modelId)) {
        throw new PlatformError("model_not_entitled", `当前套餐不包含模型 ${modelId}`);
      }
    },

    async chargeUsage({ userId, requestId, costMicros }) {
      if (costMicros <= 0) {
        return { fromPlanMicros: 0, fromBalanceMicros: 0, shortfallMicros: 0 };
      }

      // 先扣套餐额度。套餐里剩余额度不足时只扣掉能扣的部分，差额落到余额。
      const active = await this.getActivePlan(userId);
      let fromPlanMicros = 0;
      if (active && isSubscriptionActive(active.subscription, deps.now())) {
        fromPlanMicros = await deps.plans.consumeSubscriptionQuota({
          subscriptionId: active.subscription.id,
          amountMicros: costMicros,
        });
      }
      const dueFromBalance = costMicros - fromPlanMicros;
      if (dueFromBalance <= 0) {
        return { fromPlanMicros, fromBalanceMicros: 0, shortfallMicros: 0 };
      }

      // 预扣是按 max_tokens 估算的，实际用量可能超出估算。
      // 预付费系统没有办法事后追缴，所以按可用余额封顶扣减，差额作为平台承担的风险记进备注——
      // 这里如果直接扣成负数，会违反余额非负约束，让用户看到一个 500 而账目也没记上。
      const available = await this.getAvailableMicros(userId);
      const fromBalanceMicros = Math.min(dueFromBalance, available);
      const shortfallMicros = dueFromBalance - fromBalanceMicros;
      if (fromBalanceMicros > 0) {
        await applyLedger({
          userId,
          amountMicros: -fromBalanceMicros,
          kind: "usage",
          requestId,
          note:
            shortfallMicros > 0
              ? `模型调用扣费（实际费用超出可用余额 ${formatMicros(shortfallMicros)}，已按可用余额扣减）`
              : "模型调用扣费",
          createdBy: null,
          now: deps.now(),
        });
      }
      return { fromPlanMicros, fromBalanceMicros, shortfallMicros };
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
