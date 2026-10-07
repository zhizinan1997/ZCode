/**
 * 平台配置默认值：输出上限（审计#9）与上游无数据超时（审计#14）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resolvePlatformConfig } from "../src/adapters/config.js";
import { TEST_TOKEN_SECRET } from "./helpers.js";

test("配置默认值：单次输出上限 32768，上游无数据超时 60 秒（审计#9、#14）", () => {
  const config = resolvePlatformConfig({ ZCODE_PLATFORM_TOKEN_SECRET: TEST_TOKEN_SECRET });
  assert.equal(config.outputTokenCap, 32_768);
  assert.equal(config.upstreamIdleTimeoutMs, 60_000);
});

test("配置覆盖：输出上限 0 表示不限制，idle 超时可显式配置（审计#9、#14）", () => {
  const config = resolvePlatformConfig({
    ZCODE_PLATFORM_TOKEN_SECRET: TEST_TOKEN_SECRET,
    ZCODE_PLATFORM_OUTPUT_TOKEN_CAP: "0",
    ZCODE_PLATFORM_UPSTREAM_IDLE_TIMEOUT_MS: "1500",
  });
  assert.equal(config.outputTokenCap, 0);
  assert.equal(config.upstreamIdleTimeoutMs, 1_500);
});

test("配置校验：idle 超时必须是正整数（审计#14）", () => {
  assert.throws(() =>
    resolvePlatformConfig({
      ZCODE_PLATFORM_TOKEN_SECRET: TEST_TOKEN_SECRET,
      ZCODE_PLATFORM_UPSTREAM_IDLE_TIMEOUT_MS: "-1",
    }),
  );
});
