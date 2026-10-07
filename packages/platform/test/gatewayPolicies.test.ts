/**
 * 网关的纯策略：路径白名单（审计#3）、include_usage 注入（审计#2）、
 * 转发请求头白名单（审计#13）。这些规则不依赖数据库或网络，单独覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  injectStreamUsageOption,
  resolveGatewayEndpoint,
  type GatewayProvider,
} from "../src/domain/gateway.js";
import { buildUpstreamHeaders } from "../src/app/gatewayWire.js";

function provider(
  protocol: GatewayProvider["protocol"],
  overrides: Partial<GatewayProvider> = {},
): GatewayProvider {
  return {
    id: protocol,
    label: protocol,
    upstreamBaseUrl: "https://upstream.test",
    apiKey: "sk-upstream-secret",
    protocol,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("路径白名单：anthropic 只放行 messages/count_tokens/models（审计#3）", () => {
  assert.equal(resolveGatewayEndpoint("anthropic", "/v1/messages")?.billable, true);
  assert.equal(resolveGatewayEndpoint("anthropic", "/v1/messages/count_tokens")?.billable, false);
  assert.equal(resolveGatewayEndpoint("anthropic", "/v1/models")?.billable, false);
  // 其余路径一律拒绝，不做透传
  assert.equal(resolveGatewayEndpoint("anthropic", "/v1/complete"), null);
  assert.equal(resolveGatewayEndpoint("anthropic", "/v1/messages/"), null);
  assert.equal(resolveGatewayEndpoint("anthropic", "/"), null);
});

test("路径白名单：openai 与 openai-compatible 一致（审计#3）", () => {
  for (const protocol of ["openai", "openai-compatible"] as const) {
    assert.equal(resolveGatewayEndpoint(protocol, "/chat/completions")?.billable, true);
    assert.equal(resolveGatewayEndpoint(protocol, "/responses")?.billable, true);
    assert.equal(resolveGatewayEndpoint(protocol, "/models")?.billable, false);
    // SDK 惯例的 /v1 前缀写法：同样的端点，同样放行
    assert.equal(resolveGatewayEndpoint(protocol, "/v1/chat/completions")?.billable, true);
    assert.equal(resolveGatewayEndpoint(protocol, "/v1/responses")?.billable, true);
    assert.equal(resolveGatewayEndpoint(protocol, "/v1/models")?.billable, false);
    assert.equal(resolveGatewayEndpoint(protocol, "/v1/messages"), null);
    assert.equal(resolveGatewayEndpoint(protocol, "/embeddings"), null);
    assert.equal(resolveGatewayEndpoint(protocol, "/v1/embeddings"), null);
  }
});

test("include_usage 注入：只对 OpenAI 流式对话端点生效（审计#2）", () => {
  const injected = injectStreamUsageOption({
    protocol: "openai",
    upstreamPath: "/chat/completions",
    body: { model: "m", stream: true, max_tokens: 1 },
  });
  assert.deepEqual(injected?.["stream_options"], { include_usage: true });
  assert.equal(injected?.["model"], "m");

  // /v1 前缀写法（SDK 惯例）同样注入：否则这条路径会绕过流式计费（审计#2）
  const injectedWithV1 = injectStreamUsageOption({
    protocol: "openai",
    upstreamPath: "/v1/chat/completions",
    body: { model: "m", stream: true },
  });
  assert.deepEqual(injectedWithV1?.["stream_options"], { include_usage: true });

  // 已自带 include_usage：不改写
  assert.equal(
    injectStreamUsageOption({
      protocol: "openai",
      upstreamPath: "/chat/completions",
      body: { stream: true, stream_options: { include_usage: true } },
    }),
    null,
  );
  // 已有其它 stream_options 字段：保留
  const merged = injectStreamUsageOption({
    protocol: "openai-compatible",
    upstreamPath: "/chat/completions",
    body: { stream: true, stream_options: { foo: "bar" } },
  });
  assert.deepEqual(merged?.["stream_options"], { foo: "bar", include_usage: true });

  // 非流式、非对话端点、非 OpenAI 协议：都不改写
  assert.equal(
    injectStreamUsageOption({
      protocol: "openai",
      upstreamPath: "/chat/completions",
      body: { stream: false },
    }),
    null,
  );
  assert.equal(
    injectStreamUsageOption({
      protocol: "openai",
      upstreamPath: "/responses",
      body: { stream: true },
    }),
    null,
  );
  assert.equal(
    injectStreamUsageOption({
      protocol: "anthropic",
      upstreamPath: "/v1/messages",
      body: { stream: true },
    }),
    null,
  );
});

test("转发头白名单：cookie/UA/IP/请求 id 不上送，anthropic key 由平台注入（审计#13）", () => {
  const clientHeaders = new Headers({
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "prompt-caching-2024-07-31",
    "openai-organization": "org-1",
    authorization: "Bearer user-session-token",
    "x-api-key": "client-supplied-key",
    cookie: "session=abc",
    "user-agent": "ZCode/1.0",
    "x-forwarded-for": "203.0.113.7",
    "cf-connecting-ip": "203.0.113.7",
    "x-zcode-request-id": "req-1",
    "accept-encoding": "gzip",
  });

  const result = buildUpstreamHeaders({
    clientHeaders,
    provider: provider("anthropic"),
  });
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "accept",
      "anthropic-beta",
      "anthropic-version",
      "content-type",
      "openai-organization",
      "x-api-key",
    ].sort(),
  );
  assert.equal(result["x-api-key"], "sk-upstream-secret");
  assert.equal(result["authorization"], undefined);
});

test("转发头白名单：非 anthropic 协议用 authorization Bearer 注入平台 key（审计#13）", () => {
  const result = buildUpstreamHeaders({
    clientHeaders: new Headers({
      "content-type": "application/json",
      "openai-beta": "assistants=v2",
      authorization: "Bearer user-session-token",
      cookie: "session=abc",
    }),
    provider: provider("openai"),
  });
  assert.deepEqual(Object.keys(result).sort(), ["authorization", "content-type", "openai-beta"]);
  assert.equal(result["authorization"], "Bearer sk-upstream-secret");
});
