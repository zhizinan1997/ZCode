/**
 * 套餐领域类型与规则（纯逻辑）。
 *
 * 套餐是"管理员发给用户的额度包"：在有效期内提供一定额度，并限定可用的模型范围。
 * 它的作用是运营抓手，不改变计费口径本身——额度用尽后仍按余额扣费。
 */
import type { Micros } from "./money.js";

export interface PlanRecord {
  readonly id: string;
  readonly name: string;
  /** 套餐额度（微元）。额度是"抵扣池"，用尽后继续按余额扣费。 */
  readonly quotaMicros: Micros;
  /** 有效期天数；null 表示长期有效。 */
  readonly durationDays: number | null;
  /** 允许调用的模型 id 列表；空数组表示不限制模型。 */
  readonly allowedModels: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SubscriptionRecord {
  readonly id: string;
  readonly userId: string;
  readonly planId: string;
  /** 剩余额度（微元）。 */
  readonly remainingMicros: Micros;
  readonly startsAt: number;
  /** epoch 毫秒；null 表示长期有效。 */
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly createdAt: number;
}

export function isSubscriptionActive(subscription: SubscriptionRecord, now: number): boolean {
  if (subscription.revokedAt !== null) {
    return false;
  }
  return subscription.expiresAt === null || subscription.expiresAt > now;
}

/**
 * 套餐是否覆盖某个模型。
 * 空 allowedModels 表示不限制；这样可以先发"通用套餐"，再把受限套餐用于分层。
 */
export function isModelAllowedByPlan(
  subscription: SubscriptionRecord,
  plan: PlanRecord,
  modelId: string,
): boolean {
  if (plan.allowedModels.length === 0) {
    return true;
  }
  return plan.allowedModels.includes(modelId);
}

/** 从一组订阅里挑出当前有效的那个（同时只有一个生效）。 */
export function pickActiveSubscription(
  subscriptions: readonly { subscription: SubscriptionRecord; plan: PlanRecord }[],
  now: number,
): { subscription: SubscriptionRecord; plan: PlanRecord } | null {
  const active = subscriptions
    .filter((item) => isSubscriptionActive(item.subscription, now))
    .sort((left, right) => right.subscription.createdAt - left.subscription.createdAt);
  return active[0] ?? null;
}
