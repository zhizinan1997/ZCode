/**
 * 套餐与订阅用例。
 *
 * 套餐是运营抓手：管理员定义额度与可用模型，再把套餐发给用户。
 * 计费口径不因套餐而改变——额度用尽后仍按余额扣费（见 usageRepo.settleWithBilling 的结算事务）。
 */
import { PlatformError } from "../domain/errors.js";
import type { Micros } from "../domain/money.js";
import type { PlanRecord, SubscriptionRecord } from "../domain/plans.js";
import type { PlanRepository } from "./ports.js";

export interface PlanService {
  listPlans(): Promise<PlanRecord[]>;
  createPlan(input: {
    name: string;
    quotaMicros: Micros;
    durationDays: number | null;
    allowedModels: readonly string[];
  }): Promise<PlanRecord>;
  updatePlan(input: {
    planId: string;
    name?: string;
    quotaMicros?: Micros;
    durationDays?: number | null;
    allowedModels?: readonly string[];
  }): Promise<PlanRecord>;
  deletePlan(planId: string): Promise<void>;
  listSubscriptions(userId: string): Promise<SubscriptionRecord[]>;
  /** 发放套餐：撤销该用户原有订阅后签发新的，保证同一时刻只有一个生效。 */
  grantSubscription(input: {
    userId: string;
    planId: string;
    createdBy?: string | null;
  }): Promise<SubscriptionRecord>;
  revokeSubscriptions(userId: string): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function validateQuota(quotaMicros: Micros): void {
  if (!Number.isSafeInteger(quotaMicros) || quotaMicros < 0) {
    throw new PlatformError("invalid_request", "套餐额度必须是非负整数微元");
  }
}

function validateDuration(durationDays: number | null): void {
  if (durationDays === null) {
    return;
  }
  if (!Number.isSafeInteger(durationDays) || durationDays <= 0) {
    throw new PlatformError("invalid_request", "有效天数必须是正整数，或留空表示长期有效");
  }
}

export function createPlanService(deps: {
  readonly plans: PlanRepository;
  readonly now: () => number;
  readonly newPlanId: () => string;
  readonly newSubscriptionId: () => string;
}): PlanService {
  async function requirePlan(planId: string): Promise<PlanRecord> {
    const plan = await deps.plans.findPlan(planId);
    if (!plan) {
      throw new PlatformError("not_found", "套餐不存在");
    }
    return plan;
  }

  return {
    async listPlans() {
      return await deps.plans.listPlans();
    },

    async createPlan({ name, quotaMicros, durationDays, allowedModels }) {
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new PlatformError("invalid_request", "套餐名称不能为空");
      }
      validateQuota(quotaMicros);
      validateDuration(durationDays);
      const now = deps.now();
      const plan: PlanRecord = {
        id: deps.newPlanId(),
        name: trimmedName,
        quotaMicros,
        durationDays,
        allowedModels: [...allowedModels],
        createdAt: now,
        updatedAt: now,
      };
      await deps.plans.upsertPlan(plan);
      return plan;
    },

    async updatePlan({ planId, name, quotaMicros, durationDays, allowedModels }) {
      const existing = await requirePlan(planId);
      if (quotaMicros !== undefined) {
        validateQuota(quotaMicros);
      }
      if (durationDays !== undefined) {
        validateDuration(durationDays);
      }
      const updated: PlanRecord = {
        ...existing,
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(quotaMicros !== undefined ? { quotaMicros } : {}),
        ...(durationDays !== undefined ? { durationDays } : {}),
        ...(allowedModels !== undefined ? { allowedModels: [...allowedModels] } : {}),
        updatedAt: deps.now(),
      };
      if (!updated.name) {
        throw new PlatformError("invalid_request", "套餐名称不能为空");
      }
      await deps.plans.upsertPlan(updated);
      return updated;
    },

    async deletePlan(planId) {
      await requirePlan(planId);
      // 表上有 ON DELETE RESTRICT，直接删会抛 SQLite 的约束错误。
      // 先查引用数，才能给出管理员看得懂的提示。
      const references = await deps.plans.countSubscriptionsByPlan(planId);
      if (references > 0) {
        throw new PlatformError(
          "conflict",
          `该套餐仍被 ${references} 个订阅引用，请先撤销这些订阅再删除`,
        );
      }
      await deps.plans.removePlan(planId);
    },

    async listSubscriptions(userId) {
      return await deps.plans.listSubscriptions(userId);
    },

    async grantSubscription({ userId, planId }) {
      const plan = await requirePlan(planId);
      const now = deps.now();
      // 先撤销原有订阅：同一时刻只允许一个生效套餐，
      // 否则额度来源会变得不可解释，用户也会看到两个剩余额度。
      await deps.plans.revokeSubscriptions(userId, now);
      const subscription: SubscriptionRecord = {
        id: deps.newSubscriptionId(),
        userId,
        planId: plan.id,
        remainingMicros: plan.quotaMicros,
        startsAt: now,
        expiresAt: plan.durationDays === null ? null : now + plan.durationDays * DAY_MS,
        revokedAt: null,
        createdAt: now,
      };
      await deps.plans.upsertSubscription(subscription);
      return subscription;
    },

    async revokeSubscriptions(userId) {
      await deps.plans.revokeSubscriptions(userId, deps.now());
    },
  };
}
