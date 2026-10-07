/** 主键生成：带类型前缀，便于在日志与数据库里一眼看出实体种类。 */
import { randomUUID } from "node:crypto";

export function newUserId(): string {
  return `usr_${randomUUID()}`;
}

export function newSessionId(): string {
  return `ses_${randomUUID()}`;
}

export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

export function newLedgerEntryId(): string {
  return `led_${randomUUID()}`;
}

export function newPlanId(): string {
  return `plan_${randomUUID()}`;
}

export function newSubscriptionId(): string {
  return `sub_${randomUUID()}`;
}

export function newReleaseId(): string {
  return `rel_${randomUUID()}`;
}

export function newProviderId(): string {
  return `prv_${randomUUID()}`;
}
