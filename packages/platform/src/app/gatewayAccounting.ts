/**
 * 网关的用量记账：结算入账与被拒请求留痕。
 *
 * 从 gatewayService 拆出来是因为两者关注点不同：那边只保留"准入 → 转发 → 计量"的流程，
 * 这里只负责把一次请求的结果落进 usage_records 与 ledger。
 * 结算委托给 usageRepo.settleWithBilling 的单事务（审计#6），
 * 失败时整体回滚，记录保持 reserved，由滞留预扣释放兜底。
 */
import { isZeroUsage } from "../domain/billing.js";
import {
  computeTokenCostMicros,
  type Micros,
  type ModelPrice,
  type TokenUsage,
} from "../domain/money.js";
import { EMPTY_USAGE } from "../domain/usageParsing.js";
import type { UsageRepository } from "./ports.js";

export interface GatewayAccountingDeps {
  readonly usage: UsageRepository;
  readonly now: () => number;
}

/** 上游没返回用量时的兜底标记；写进 usage_records.error_message，便于事后核对。 */
export const USAGE_MISSING_MESSAGE = "上游用量缺失，按预扣金额计费";

/**
 * 结算并写账（审计#6）。
 *
 * 状态改终态、套餐扣除、余额流水在同一事务里完成：要么全部生效，要么整体回滚。
 * 结算异常向上抛，由调用方决定兜底方式；不会改变已经产生的上游响应。
 */
export async function settleGatewayUsage(
  deps: GatewayAccountingDeps,
  input: {
    requestId: string;
    userId: string;
    usage: TokenUsage;
    price: ModelPrice;
    reserveMicros: Micros;
    httpStatus: number | null;
    errorMessage: string | null;
    status?: "ok" | "upstream_error";
  },
): Promise<void> {
  const isSuccess = input.httpStatus !== null && input.httpStatus >= 200 && input.httpStatus < 300;
  // 审计#2 兜底：2xx 但没有拿到任何用量（上游未回流式 usage / Responses 用量位置不同）
  // 不能按 0 记账，否则用户白嫖一次真实调用；按预扣金额计费并标注原因。
  // 4xx/5xx 是上游明确失败，不兜底，仍记 0 费用。
  const usageMissing = isSuccess && isZeroUsage(input.usage) && input.reserveMicros > 0;
  const costMicros = usageMissing
    ? input.reserveMicros
    : computeTokenCostMicros(input.usage, input.price);
  await deps.usage.settleWithBilling({
    requestId: input.requestId,
    userId: input.userId,
    usage: input.usage,
    costMicros,
    status:
      input.status ??
      (input.httpStatus !== null && input.httpStatus >= 400 ? "upstream_error" : "ok"),
    httpStatus: input.httpStatus,
    errorMessage: usageMissing ? USAGE_MISSING_MESSAGE : input.errorMessage,
    now: deps.now(),
  });
}

/** 被拒请求留痕：没有产生上游费用，记 0 费用并直接进入 rejected 终态。 */
export async function recordRejectedUsage(
  deps: GatewayAccountingDeps,
  input: {
    requestId: string;
    userId: string;
    providerId: string;
    modelId: string | null;
    httpStatus: number;
    message: string;
  },
): Promise<void> {
  try {
    await deps.usage.insertReservation({
      requestId: input.requestId,
      userId: input.userId,
      providerId: input.providerId,
      modelId: input.modelId,
      costMicros: 0,
      httpStatus: input.httpStatus,
      durationMs: null,
      now: deps.now(),
    });
    await deps.usage.settle({
      requestId: input.requestId,
      userId: input.userId,
      usage: EMPTY_USAGE,
      costMicros: 0,
      status: "rejected",
      httpStatus: input.httpStatus,
      errorMessage: input.message,
      now: deps.now(),
    });
  } catch {
    // 留痕失败不能改变对客户端的拒绝结果。
  }
}
