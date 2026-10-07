/**
 * 计费领域类型与规则（纯逻辑）。
 *
 * 金额单位见 money.ts：一律整数微元，禁止浮点。
 */
import type { Micros, ModelPrice, TokenUsage } from "./money.js";
import { computeTokenCostMicros } from "./money.js";

export const LEDGER_KINDS = ["recharge", "usage", "plan_grant", "adjustment"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const USAGE_STATUSES = ["reserved", "ok", "upstream_error", "rejected"] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

export interface LedgerEntry {
  readonly id: string;
  readonly userId: string;
  readonly kind: LedgerKind;
  readonly amountMicros: Micros;
  /** 用量扣费关联的请求 id；它与 usage_records 的主键共同构成幂等键。 */
  readonly requestId: string | null;
  readonly note: string | null;
  readonly createdBy: string | null;
  readonly createdAt: number;
}

export interface UsageRecord {
  readonly requestId: string;
  readonly userId: string;
  readonly providerId: string;
  readonly modelId: string | null;
  readonly usage: TokenUsage;
  readonly costMicros: Micros;
  readonly status: UsageStatus;
  readonly httpStatus: number | null;
  readonly durationMs: number | null;
  readonly errorMessage: string | null;
  readonly createdAt: number;
  readonly settledAt: number | null;
}

/** 单次请求在未指定 max_tokens 时用于预扣的默认输出 token 数。 */
export const DEFAULT_RESERVE_OUTPUT_TOKENS = 8_192;

/**
 * 预扣金额的下限。
 *
 * 必须大于 0：余额为 0 的用户也要能通过"预扣 > 可用余额"被拦住。
 * 若允许预扣为 0，零余额请求就能穿透到上游，平台替他付钱。
 */
export const MIN_RESERVE_MICROS: Micros = 1;

/**
 * 可用余额 = 余额 - 未结算的预扣总额。
 *
 * 预扣用 usage_records 里 status='reserved' 的行表达，
 * 这样"已发生的上游费用但尚未结算"的部分不会被当成可用余额重复花出去。
 */
export function resolveAvailableMicros(balanceMicros: Micros, reservedMicros: Micros): Micros {
  return Math.max(0, balanceMicros - reservedMicros);
}

/**
 * 估算预扣金额。
 *
 * 这只是上限估计，不是计费结果：真实费用在结算时按上游返回的实际用量计算。
 * 它需要满足两个目的——拦住零余额用户，以及限制单次请求的最大敞口。
 */
export function estimateReserveMicros(input: {
  price: ModelPrice;
  requestedMaxOutputTokens?: number | null;
  /** 单次请求的输出上限；0 或未设置表示不限制。 */
  outputTokenCap?: number;
}): Micros {
  const cap = input.outputTokenCap && input.outputTokenCap > 0 ? input.outputTokenCap : null;
  const requested = input.requestedMaxOutputTokens;
  const requestedValid =
    typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0;
  const plannedTokens = requestedValid
    ? cap
      ? Math.min(requested, cap)
      : requested
    : cap ?? DEFAULT_RESERVE_OUTPUT_TOKENS;

  const estimated = computeTokenCostMicros(
    {
      inputTokens: 0,
      outputTokens: plannedTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    input.price,
  );
  return Math.max(estimated, MIN_RESERVE_MICROS);
}

/** 结算费用：按实际用量计算，绝不低于 0。 */
export function resolveSettledCostMicros(usage: TokenUsage, price: ModelPrice): Micros {
  return computeTokenCostMicros(usage, price);
}
