/**
 * 计费领域规则：可用额度含订阅（审计#5）、预扣含输入估算与输出上限（审计#9）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RESERVE_OUTPUT_TOKENS,
  MIN_RESERVE_MICROS,
  estimateInputTokensFromBytes,
  estimateReserveMicros,
  isZeroUsage,
  resolveAvailableMicros,
} from "../src/domain/billing.js";
import { microsFromDecimalString, type ModelPrice } from "../src/domain/money.js";

const PRICE: ModelPrice = {
  inputMicrosPerMillion: microsFromDecimalString("3"),
  outputMicrosPerMillion: microsFromDecimalString("15"),
  cacheReadMicrosPerMillion: 0,
  cacheWriteMicrosPerMillion: 0,
};

test("可用额度 = 余额 − 预扣 + 有效订阅剩余，且不为负（审计#5）", () => {
  assert.equal(resolveAvailableMicros(100, 30), 70);
  // 余额为 0 的套餐用户，可用额度就是套餐剩余
  assert.equal(resolveAvailableMicros(0, 0, 500), 500);
  assert.equal(resolveAvailableMicros(100, 30, 500), 570);
  // 预扣超过余额与套餐时封底为 0，不返回负数
  assert.equal(resolveAvailableMicros(10, 50), 0);
  assert.equal(resolveAvailableMicros(10, 50, 20), 0);
});

test("输入 token 按请求体字节数 ÷ 4 估算（审计#9）", () => {
  assert.equal(estimateInputTokensFromBytes(4000), 1000);
  // 向上取整：不足 4 字节也按 1 个 token 计
  assert.equal(estimateInputTokensFromBytes(1), 1);
  assert.equal(estimateInputTokensFromBytes(5), 2);
  assert.equal(estimateInputTokensFromBytes(0), 0);
  assert.equal(estimateInputTokensFromBytes(-1), 0);
  assert.equal(estimateInputTokensFromBytes(null), 0);
  assert.equal(estimateInputTokensFromBytes(undefined), 0);
  assert.equal(estimateInputTokensFromBytes(Number.NaN), 0);
});

test("预扣估算：输入与输出一起算，输入部分随请求体增长（审计#9）", () => {
  const outputOnly = estimateReserveMicros({ price: PRICE, requestedMaxOutputTokens: 1000 });
  const withInput = estimateReserveMicros({
    price: PRICE,
    requestedMaxOutputTokens: 1000,
    requestBytes: 40_000,
  });
  // 40000 字节 ≈ 10000 input token * 3 元/M = 0.03 元 = 30000 微元
  assert.equal(withInput - outputOnly, 30_000);
});

test("预扣估算：未声明 max_tokens 用默认输出上限，请求超过 cap 时按 cap 封顶", () => {
  const defaulted = estimateReserveMicros({ price: PRICE });
  const withDefaultTokens = estimateReserveMicros({
    price: PRICE,
    requestedMaxOutputTokens: DEFAULT_RESERVE_OUTPUT_TOKENS,
  });
  assert.equal(defaulted, withDefaultTokens);

  const capped = estimateReserveMicros({
    price: PRICE,
    requestedMaxOutputTokens: 1_000_000,
    outputTokenCap: 32_768,
  });
  const atCap = estimateReserveMicros({ price: PRICE, requestedMaxOutputTokens: 32_768 });
  assert.equal(capped, atCap);
  // cap 为 0 表示不限制
  const uncapped = estimateReserveMicros({
    price: PRICE,
    requestedMaxOutputTokens: 1_000_000,
    outputTokenCap: 0,
  });
  assert.ok(uncapped > capped);
});

test("预扣估算：零价模型也至少有 1 微元，零余额请求不能穿透（审计口径#3）", () => {
  const zeroPrice: ModelPrice = {
    inputMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    cacheReadMicrosPerMillion: 0,
    cacheWriteMicrosPerMillion: 0,
  };
  assert.equal(estimateReserveMicros({ price: zeroPrice }), MIN_RESERVE_MICROS);
});

test("零用量判定用于用量缺失兜底（审计#2）", () => {
  assert.equal(
    isZeroUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    true,
  );
  assert.equal(
    isZeroUsage({ inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    false,
  );
  assert.equal(
    isZeroUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 5, cacheWriteTokens: 0 }),
    false,
  );
});
