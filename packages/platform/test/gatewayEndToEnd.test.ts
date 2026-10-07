/**
 * 网关端到端（审计验收#12）：登录 → 建 provider → 配单价 → 充值 →
 * 带 `Authorization: Bearer` 调网关对话端点 → 断言计费落账。
 *
 * 计费正确性不依赖真实厂商：上游传输用假实现替换。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createPlatformApp } from "../src/adapters/http/app.js";
import { createLogger } from "../src/adapters/log.js";
import type { UpstreamTransport } from "../src/app/ports.js";
import { microsFromDecimalString } from "../src/domain/money.js";
import { createTestRuntime } from "./helpers.js";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "admin-password";

test("登录后经网关调用对话端点，按实际用量扣费并写流水", async () => {
  const forwarded: { url: string; headers: Record<string, string>; body: string | null }[] = [];
  const transport: UpstreamTransport = {
    async forward(request) {
      forwarded.push({ url: request.url, headers: request.headers, body: request.body });
      return new Response(
        JSON.stringify({ usage: { input_tokens: 1_000_000, output_tokens: 100_000 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
  const runtime = await createTestRuntime({}, { upstreamTransport: transport });
  try {
    const admin = await runtime.accounts.createUser({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      role: "admin",
    });
    const app = createPlatformApp({
      config: runtime.config,
      logger: createLogger({ scope: "test", level: "error", write: () => {} }),
      accounts: runtime.accounts,
      billing: runtime.billing,
      catalog: runtime.catalog,
      plans: runtime.plans,
      releases: runtime.releases,
      operations: runtime.operations,
      modelPublish: runtime.modelPublish,
      gateway: runtime.gateway,
      providers: runtime.repositories.providers,
      prices: runtime.repositories.prices,
      usage: runtime.repositories.usage,
      now: () => Date.now(),
      newProviderId: runtime.newProviderId,
    });

    // 1. 登录拿令牌
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    assert.equal(login.status, 200);
    const token = ((await login.json()) as { token: string }).token;
    const auth = { authorization: `Bearer ${token}` };

    // 2. 管理员配置上游 provider 与单价
    const providerResponse = await app.request("/api/admin/providers/anthropic", {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        label: "Anthropic",
        upstreamBaseUrl: "https://upstream.test",
        protocol: "anthropic",
        apiKey: "sk-upstream-secret",
      }),
    });
    assert.equal(providerResponse.status, 204);

    const priceResponse = await app.request("/api/admin/prices/claude-test", {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ input: "3", output: "15" }),
    });
    assert.equal(priceResponse.status, 204);

    const recharge = await app.request(`/api/admin/users/${admin.id}/recharge`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ amount: "10" }),
    });
    assert.equal(recharge.status, 200);

    // 3. 带用户令牌调网关对话端点
    const gatewayResponse = await app.request("/api/v1/gateway/anthropic/v1/messages", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-zcode-request-id": "e2e-request-1",
        cookie: "session=abc",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 1000,
        messages: [{ role: "user", content: "你好" }],
      }),
    });
    assert.equal(gatewayResponse.status, 200);
    const responseBody = (await gatewayResponse.json()) as { usage: { input_tokens: number } };
    assert.equal(responseBody.usage.input_tokens, 1_000_000);

    // 4. 转发链路：平台 key 注入，客户端令牌与 cookie 不上送
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0]?.url, "https://upstream.test/v1/messages");
    assert.equal(forwarded[0]?.headers["x-api-key"], "sk-upstream-secret");
    assert.equal(forwarded[0]?.headers["authorization"], undefined);
    assert.equal(forwarded[0]?.headers["cookie"], undefined);

    // 5. 计费：1M input * 3 元 + 0.1M output * 15 元 = 4.5 元
    const usageRecord = await runtime.repositories.usage.findById("e2e-request-1");
    assert.equal(usageRecord?.status, "ok");
    assert.equal(usageRecord?.costMicros, microsFromDecimalString("4.5"));

    const summary = await runtime.billing.getSummary(admin.id);
    assert.equal(
      summary.balanceMicros,
      microsFromDecimalString("10") - microsFromDecimalString("4.5"),
    );
    const reconcile = await runtime.billing.reconcileBalance(admin.id);
    assert.equal(reconcile.drift, 0);
  } finally {
    runtime.dispose();
  }
});
