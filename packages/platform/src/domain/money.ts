/**
 * 金额与单价运算。
 *
 * 单位约定（全平台统一，禁止用浮点数表示金额）：
 * - 金额一律是整数「微元」，1 微元 = 1e-6 个货币单位。1.00 元 = 1_000_000 微元。
 * - 单价一律是整数「微元 / 每百万 token」。例如 $3 / 1M token = 3_000_000 微元。
 *
 * 之所以不用浮点：余额与扣费要能精确对账，浮点累加会产生不可解释的尾差。
 */

export const MICROS_PER_UNIT = 1_000_000;
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** 整数微元。类型别名只用于表达意图，运行期就是 number。 */
export type Micros = number;

/** 一次模型调用的 token 用量，按计价档位拆分。 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** 单个模型的四档单价，单位：微元 / 每百万 token。 */
export interface ModelPrice {
  readonly inputMicrosPerMillion: Micros;
  readonly outputMicrosPerMillion: Micros;
  readonly cacheReadMicrosPerMillion: Micros;
  readonly cacheWriteMicrosPerMillion: Micros;
}

export const ZERO_PRICE: ModelPrice = {
  inputMicrosPerMillion: 0,
  outputMicrosPerMillion: 0,
  cacheReadMicrosPerMillion: 0,
  cacheWriteMicrosPerMillion: 0,
};

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} 必须是非负安全整数，收到 ${String(value)}`);
  }
}

/** 把带小数的货币金额（如 "12.5"）转成整数微元；最多 6 位小数。 */
export function microsFromDecimalString(value: string): Micros {
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(trimmed);
  if (!match) {
    throw new RangeError(`金额格式非法（只接受非负十进制、最多 6 位小数）：${value}`);
  }
  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(6, "0");
  const micros = whole * MICROS_PER_UNIT + Number(fraction);
  assertNonNegativeInteger(micros, "金额");
  return micros;
}

/** 整数微元转成可用于展示的十进制字符串，去掉尾随 0。 */
export function formatMicros(micros: Micros): string {
  assertNonNegativeInteger(micros, "金额");
  const whole = Math.floor(micros / MICROS_PER_UNIT);
  const fraction = String(micros % MICROS_PER_UNIT)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * 按单价计算一次调用的费用（微元）。
 *
 * 用 BigInt 做中间乘积：token 数与单价都可能很大，先乘后除在 number 下会超出安全整数范围。
 * 结果向上取整——宁可多收一个微元，也不让平台因舍入少收。
 */
export function computeTokenCostMicros(usage: TokenUsage, price: ModelPrice): Micros {
  const terms: readonly (readonly [number, Micros])[] = [
    [usage.inputTokens, price.inputMicrosPerMillion],
    [usage.outputTokens, price.outputMicrosPerMillion],
    [usage.cacheReadTokens, price.cacheReadMicrosPerMillion],
    [usage.cacheWriteTokens, price.cacheWriteMicrosPerMillion],
  ];

  let numerator = 0n;
  for (const [tokens, microsPerMillion] of terms) {
    assertNonNegativeInteger(tokens, "token 数");
    assertNonNegativeInteger(microsPerMillion, "单价");
    numerator += BigInt(tokens) * BigInt(microsPerMillion);
  }

  const divisor = BigInt(TOKENS_PER_PRICE_UNIT);
  const rounded = (numerator + divisor - 1n) / divisor;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("费用超出可表示范围");
  }
  return Number(rounded);
}

export function addMicros(left: Micros, right: Micros): Micros {
  const sum = left + right;
  assertNonNegativeInteger(sum, "金额和");
  return sum;
}

/** 余额是否足够支付；余额与费用都必须是合法微元。 */
export function canAfford(balanceMicros: Micros, costMicros: Micros): boolean {
  assertNonNegativeInteger(balanceMicros, "余额");
  assertNonNegativeInteger(costMicros, "费用");
  return balanceMicros >= costMicros;
}
