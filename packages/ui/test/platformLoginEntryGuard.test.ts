import assert from "node:assert/strict";
import test from "node:test";
import { shouldOpenProviderAvailabilityLoginEntry } from "../src/lib/modelProviderAvailability.js";

/**
 * 启动登录入口门禁的判定表。
 *
 * 这里固化的是"登录态优先"这一约定：已登录用户不应因为缺少厂商 family domain
 * 被弹回登录页——平台账号登录不涉及 family 选择，登录态本身就代表可用。
 */
test("已登录且无 family domain（平台账号）不再弹登录页", () => {
  assert.equal(
    shouldOpenProviderAvailabilityLoginEntry({
      user: { id: "usr_1" },
      providerFamilyDomain: "",
      hasUsableProvider: false,
    }),
    false,
  );
});

test("已登录且有 family domain 时保持不弹", () => {
  assert.equal(
    shouldOpenProviderAvailabilityLoginEntry({
      user: { id: "usr_1" },
      providerFamilyDomain: "zai",
      hasUsableProvider: true,
    }),
    false,
  );
});

test("未登录且未选 family domain 时必须引导登录", () => {
  assert.equal(
    shouldOpenProviderAvailabilityLoginEntry({
      user: null,
      providerFamilyDomain: "",
      hasUsableProvider: true,
    }),
    true,
  );
});

test("未登录但有 family domain 与可用 provider 时不弹", () => {
  assert.equal(
    shouldOpenProviderAvailabilityLoginEntry({
      user: null,
      providerFamilyDomain: "bigmodel",
      hasUsableProvider: true,
    }),
    false,
  );
});

test("未登录且没有任何可用 provider 时必须引导登录", () => {
  assert.equal(
    shouldOpenProviderAvailabilityLoginEntry({
      user: null,
      providerFamilyDomain: "zai",
      hasUsableProvider: false,
    }),
    true,
  );
});

test("family domain 为 undefined 与空串等价", () => {
  assert.equal(
    shouldOpenProviderAvailabilityLoginEntry({
      user: null,
      providerFamilyDomain: undefined,
      hasUsableProvider: true,
    }),
    true,
  );
});
