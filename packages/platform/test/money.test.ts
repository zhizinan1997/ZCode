import assert from "node:assert/strict";
import test from "node:test";
import {
  computeTokenCostMicros,
  formatMicros,
  microsFromDecimalString,
  type ModelPrice,
  type TokenUsage,
} from "../src/domain/money.js";

const PRICE: ModelPrice = {
  inputMicrosPerMillion: 3_000_000, // 3 元 / 1M input
  outputMicrosPerMillion: 15_000_000, // 15 元 / 1M output
  cacheReadMicrosPerMillion: 300_000, // 0.3 元 / 1M cache read
  cacheWriteMicrosPerMillion: 3_750_000, // 3.75 元 / 1M cache write
};

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...partial };
}

test("金额十进制字符串转微元", () => {
  assert.equal(microsFromDecimalString("1"), 1_000_000);
  assert.equal(microsFromDecimalString("0.5"), 500_000);
  assert.equal(microsFromDecimalString("12.345678"), 12_345_678);
  assert.equal(microsFromDecimalString("0"), 0);
});

test("金额字符串拒绝非法输入", () => {
  assert.throws(() => microsFromDecimalString("-1"));
  assert.throws(() => microsFromDecimalString("1.1234567"), /最多 6 位小数/);
  assert.throws(() => microsFromDecimalString("abc"));
  assert.throws(() => microsFromDecimalString(""));
});

test("微元格式化去掉尾随 0", () => {
  assert.equal(formatMicros(1_000_000), "1");
  assert.equal(formatMicros(1_500_000), "1.5");
  assert.equal(formatMicros(12_345_678), "12.345678");
  assert.equal(formatMicros(0), "0");
});

test("按单价计算费用：各档位分别计价后求和", () => {
  const cost = computeTokenCostMicros(
    usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    PRICE,
  );
  assert.equal(cost, 18_000_000); // 3 元 + 15 元
});

test("按单价计算费用：小数会向上取整，避免平台少收", () => {
  // 1 个 input token：3_000_000 * 1 / 1_000_000 = 3 微元，整数无余数
  assert.equal(computeTokenCostMicros(usage({ inputTokens: 1 }), PRICE), 3);
  // 1 个 cache read token：300_000 / 1_000_000 = 0.3 微元 → 进位到 1
  assert.equal(computeTokenCostMicros(usage({ cacheReadTokens: 1 }), PRICE), 1);
});

test("按单价计算费用：缓存两档独立计入", () => {
  const cost = computeTokenCostMicros(
    usage({ cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
    PRICE,
  );
  assert.equal(cost, 300_000 + 3_750_000);
});

test("零用量不产生费用", () => {
  assert.equal(computeTokenCostMicros(usage({}), PRICE), 0);
});

test("负 token 数与非整数被拒绝", () => {
  assert.throws(() => computeTokenCostMicros(usage({ inputTokens: -1 }), PRICE));
  assert.throws(() => computeTokenCostMicros(usage({ inputTokens: 1.5 }), PRICE));
});

test("大额用量不丢精度（超出 number 乘法安全范围也能正确进位）", () => {
  const huge: ModelPrice = {
    inputMicrosPerMillion: 999_999_999,
    outputMicrosPerMillion: 999_999_999,
    cacheReadMicrosPerMillion: 0,
    cacheWriteMicrosPerMillion: 0,
  };
  const tokens = 9_000_000;
  // 9_000_000 * 999_999_999 = 8999999991000000 → /1e6 = 8999999991 恰好整除
  assert.equal(computeTokenCostMicros(usage({ inputTokens: tokens }), huge), 8_999_999_991);
});
