/**
 * 网关端到端：预扣 → 转发 → 计量 → 结算 → 记账。
 *
 * 用假上游替代真实厂商：计费正确性不该依赖外网可用。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { microsFromDecimalString } from "../src/domain/money.js";
import type { UpstreamTransport } from "../src/app/ports.js";
import { createPlatformRuntime, type PlatformRuntime } from "../src/adapters/composition.js";
import { createLogger } from "../src/adapters/log.js";
import { IN_MEMORY_DATABASE_PATH } from "../src/adapters/sqlite/database.js";
import { TEST_TOKEN_SECRET } from "./helpers.js";

const PRICE = {
  inputMicrosPerMillion: microsFromDecimalString("3"),
  outputMicrosPerMillion: microsFromDecimalString("15"),
  cacheReadMicrosPerMillion: 0,
  cacheWriteMicrosPerMillion: 0,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(chunks: readonly string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

interface Harness {
  readonly runtime: PlatformRuntime;
  readonly userId: string;
  forwarded: { url: string; headers: Record<string, string>; body: string | null }[];
}

async function createHarness(options: {
  price?: typeof PRICE | null;
  transportResponse?: () => Response;
  /** 初始充值金额；默认 10 元。 */
  recharge?: string;
}): Promise<Harness> {
  const forwarded: Harness["forwarded"] = [];
  const transport: UpstreamTransport = {
    async forward(request) {
      forwarded.push({ url: request.url, headers: request.headers, body: request.body });
      return (options.transportResponse ?? (() => jsonResponse({ usage: {} })))();
    },
  };
  const runtime = await createPlatformRuntime({
    config: {
      dbPath: IN_MEMORY_DATABASE_PATH,
      host: "127.0.0.1",
      port: 0,
      tokenSecret: TEST_TOKEN_SECRET,
      sessionTtlMs: 60_000,
      logLevel: "error",
      publicOrigin: "https://platform.test",
      outputTokenCap: 0,
      upstreamTimeoutMs: 5_000,
      consoleDir: "/nonexistent-console",
      releasesDir: "/nonexistent-releases",
    },
    logger: createLogger({ scope: "test", level: "error", write: () => {} }),
    upstreamTransport: transport,
  });

  const user = await runtime.accounts.createUser({
    email: "user@example.com",
    password: "initial-password",
  });
  await runtime.repositories.providers.upsert({
    id: "anthropic",
    label: "Anthropic",
    upstreamBaseUrl: "https://upstream.test",
    apiKey: "sk-upstream-secret",
    protocol: "anthropic",
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (options.price !== null) {
    await runtime.repositories.prices.upsert({
      modelId: "claude-test",
      ...(options.price ?? PRICE),
      updatedAt: Date.now(),
    });
  }
  await runtime.billing.recharge({
    userId: user.id,
    amountMicros: microsFromDecimalString(options.recharge ?? "10"),
  });

  return { runtime, userId: user.id, forwarded };
}

function gatewayHeaders(): Headers {
  return new Headers({ "content-type": "application/json", "anthropic-version": "2023-06-01" });
}

/**
 * 按类型找流水，而不是取第一条。
 * 同一毫秒内写入的多条流水时间戳相同，排序的 tie-break 是随机 id，取第一条并不稳定。
 */
function findLedger(
  entries: readonly { kind: string; amountMicros: number }[],
  kind: string,
): { kind: string; amountMicros: number } | undefined {
  return entries.find((entry) => entry.kind === kind);
}

function requestBody(model: string, maxTokens = 1000, stream = false) {
  return JSON.stringify({ model, max_tokens: maxTokens, stream, messages: [] });
}

test("非流式调用：转发上游、按实际用量扣费、上游 key 被替换为平台 key", async () => {
  const harness = await createHarness({
    transportResponse: () =>
      jsonResponse({ usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }),
    // 充值 100 元以覆盖 18 元的实际费用
    recharge: "100",
  });
  try {
    const response = await harness.runtime.gateway.handle({
      userId: harness.userId,
      providerId: "anthropic",
      method: "POST",
      requestPath: "/api/v1/gateway/anthropic/v1/messages",
      search: "?beta=1",
      headers: gatewayHeaders(),
      bodyText: requestBody("claude-test"),
    });

    assert.equal(response.status, 200);
    // 路径与查询串原样拼到上游 baseUrl 后面
    assert.equal(harness.forwarded[0]?.url, "https://upstream.test/v1/messages?beta=1");
    // 客户端带的 key 不能到达上游，必须换成平台配置的 key
    assert.equal(harness.forwarded[0]?.headers["x-api-key"], "sk-upstream-secret");
    assert.equal(harness.forwarded[0]?.headers["authorization"], undefined);

    // 3 元 + 15 元 = 18 元
    const summary = await harness.runtime.billing.getSummary(harness.userId);
    assert.equal(summary.balanceMicros, microsFromDecimalString("100") - microsFromDecimalString("18"));
    const ledger = await harness.runtime.repositories.billing.listLedger({
      userId: harness.userId,
      limit: 10,
      offset: 0,
    });
    assert.equal(ledger.length, 2);
    const usageEntry = findLedger(ledger, "usage");
    assert.ok(usageEntry);
    assert.equal(usageEntry.amountMicros, -microsFromDecimalString("18"));

    const record = await harness.runtime.repositories.usage.findById(
      response.headers.get("x-zcode-request-id") ?? "",
    );
    assert.equal(record?.status, "ok");
    assert.equal(record?.usage.inputTokens, 1_000_000);
  } finally {
    harness.runtime.dispose();
  }
});

test("余额不足时拒绝且不转发上游", async () => {
  const harness = await createHarness({});
  try {
    // 把余额扣到接近 0：预扣按 max_tokens 估算，余额为 0 时必然被拒
    const summary = await harness.runtime.billing.getSummary(harness.userId);
    await harness.runtime.billing.adjust({
      userId: harness.userId,
      deltaMicros: -summary.balanceMicros,
    });

    const response = await harness.runtime.gateway.handle({
      userId: harness.userId,
      providerId: "anthropic",
      method: "POST",
      requestPath: "/api/v1/gateway/anthropic/v1/messages",
      search: "",
      headers: gatewayHeaders(),
      bodyText: requestBody("claude-test"),
    });

    assert.equal(response.status, 402);
    assert.equal(harness.forwarded.length, 0);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "insufficient_balance");
  } finally {
    harness.runtime.dispose();
  }
});

test("充值后同一请求即可通过（无需重启）", async () => {
  const harness = await createHarness({
    transportResponse: () => jsonResponse({ usage: { input_tokens: 0, output_tokens: 0 } }),
  });
  try {
    const summary = await harness.runtime.billing.getSummary(harness.userId);
    await harness.runtime.billing.adjust({
      userId: harness.userId,
      deltaMicros: -summary.balanceMicros,
    });
    const denied = await harness.runtime.gateway.handle({
      userId: harness.userId,
      providerId: "anthropic",
      method: "POST",
      requestPath: "/api/v1/gateway/anthropic/v1/messages",
      search: "",
      headers: gatewayHeaders(),
      bodyText: requestBody("claude-test"),
    });
    assert.equal(denied.status, 402);

    await harness.runtime.billing.recharge({
      userId: harness.userId,
      amountMicros: microsFromDecimalString("5"),
    });
    const allowed = await harness.runtime.gateway.handle({
      userId: harness.userId,
      providerId: "anthropic",
      method: "POST",
      requestPath: "/api/v1/gateway/anthropic/v1/messages",
      search: "",
      headers: gatewayHeaders(),
      bodyText: requestBody("claude-test"),
    });
    assert.equal(allowed.status, 200);
  } finally {
    harness.runtime.dispose();
  }
});

test("停用的上游返回 404 且不转发", async () => {
  const harness = await createHarness({});
  try {
    await harness.runtime.repositories.providers.upsert({
      id: "anthropic",
      label: "Anthropic",
      upstreamBaseUrl: "https://upstream.test",
      apiKey: "sk",
      protocol: "anthropic",
      enabled: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const response = await harness.runtime.gateway.handle({
      userId: harness.userId,
      providerId: "anthropic",
      method: "POST",
      requestPath: "/api/v1/gateway/anthropic/v1/messages",
      search: "",
      headers: gatewayHeaders(),
      bodyText: requestBody("claude-test"),
    });
    assert.equal(response.status, 404);
    assert.equal(harness.forwarded.length, 0);
  } finally {
    harness.runtime.dispose();
  }
});

test("流式调用：边转发边累计用量，结束后结算", async () => {
  const harness = await createHarness({
    // 实际费用 21 元，充值 100 元以覆盖
    recharge: "100",
    transportResponse: () =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2000000}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":1000000}}\n\n',
      ]),
  });
  try {
    const response = await harness.runtime.gateway.handle({
      userId: harness.userId,
      providerId: "anthropic",
      method: "POST",
      requestPath: "/api/v1/gateway/anthropic/v1/messages",
      search: "",
      headers: gatewayHeaders(),
      bodyText: requestBody("claude-test", 1000, true),
    });
    assert.equal(response.status, 200);
    // 客户端要能读到完整流
    const text = await response.text();
    assert.ok(text.includes("message_start"));

    // 结算发生在流消费完之后，等一个事件循环
    await new Promise((resolve) => setTimeout(resolve, 50));

    const ledger = await harness.runtime.repositories.billing.listLedger({
      userId: harness.userId,
      limit: 10,
      offset: 0,
    });
    // 输入 2M * 3 + 输出 1M * 15 = 6 + 15 = 21 元
    const usageEntry = findLedger(ledger, "usage");
    assert.ok(usageEntry);
    assert.equal(usageEntry.amountMicros, -microsFromDecimalString("21"));
  } finally {
    harness.runtime.dispose();
  }
});

test("上游返回错误：记为 upstream_error 且不产生费用", async () => {
  const harness = await createHarness({
    transportResponse: () => jsonResponse({ error: "boom" }, 500),
  });
  try {
    const response = await harness.runtime.gateway.handle({
      userId: harness.userId,
      providerId: "anthropic",
      method: "POST",
      requestPath: "/api/v1/gateway/anthropic/v1/messages",
      search: "",
      headers: gatewayHeaders(),
      bodyText: requestBody("claude-test"),
    });
    assert.equal(response.status, 500);

    const records = await harness.runtime.repositories.usage.list({
      userId: harness.userId,
      limit: 10,
      offset: 0,
    });
    assert.equal(records[0]?.status, "upstream_error");
    assert.equal(records[0]?.costMicros, 0);
    // 只有最初那笔充值，没有扣费
    const ledger = await harness.runtime.repositories.billing.listLedger({
      userId: harness.userId,
      limit: 10,
      offset: 0,
    });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.kind, "recharge");
  } finally {
    harness.runtime.dispose();
  }
});

test("未知模型没有单价：只计量不扣费", async () => {
  const harness = await createHarness({
    price: null,
    transportResponse: () => jsonResponse({ usage: { input_tokens: 500, output_tokens: 500 } }),
  });
  try {
    const before = await harness.runtime.billing.getSummary(harness.userId);
    const response = await harness.runtime.gateway.handle({
      userId: harness.userId,
      providerId: "anthropic",
      method: "POST",
      requestPath: "/api/v1/gateway/anthropic/v1/messages",
      search: "",
      headers: gatewayHeaders(),
      bodyText: requestBody("unpriced-model"),
    });
    assert.equal(response.status, 200);
    const after = await harness.runtime.billing.getSummary(harness.userId);
    assert.equal(after.balanceMicros, before.balanceMicros);
  } finally {
    harness.runtime.dispose();
  }
});

test("实际费用超出余额：按可用余额封顶扣减，余额不透支且差额记入流水备注", async () => {
  const harness = await createHarness({
    // 余额 10 元，实际费用 18 元：预付费无法事后追缴，只能扣到 0
    transportResponse: () =>
      jsonResponse({ usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }),
  });
  try {
    const response = await harness.runtime.gateway.handle({
      userId: harness.userId,
      providerId: "anthropic",
      method: "POST",
      requestPath: "/api/v1/gateway/anthropic/v1/messages",
      search: "",
      headers: gatewayHeaders(),
      bodyText: requestBody("claude-test"),
    });
    // 上游已经产生费用，响应仍然正常返回给用户
    assert.equal(response.status, 200);

    const summary = await harness.runtime.billing.getSummary(harness.userId);
    assert.equal(summary.balanceMicros, 0);

    const ledger = await harness.runtime.repositories.billing.listLedger({
      userId: harness.userId,
      limit: 10,
      offset: 0,
    });
    const usageEntry = findLedger(ledger, "usage");
    assert.ok(usageEntry);
    assert.equal(usageEntry.amountMicros, -microsFromDecimalString("10"));
    assert.match(String(usageEntry.note), /超出可用余额/);

    // 用量记录里保留的是真实费用，便于事后核对平台承担了多少
    const records = await harness.runtime.repositories.usage.list({
      userId: harness.userId,
      limit: 10,
      offset: 0,
    });
    assert.equal(records[0]?.costMicros, microsFromDecimalString("18"));
    assert.equal(records[0]?.status, "ok");
  } finally {
    harness.runtime.dispose();
  }
});

test("同一 request id 重复提交不重复扣费", async () => {
  const harness = await createHarness({
    transportResponse: () => jsonResponse({ usage: { input_tokens: 1000000, output_tokens: 0 } }),
  });
  try {
    const headers = gatewayHeaders();
    headers.set("x-zcode-request-id", "fixed-request-id");
    const first = await harness.runtime.gateway.handle({
      userId: harness.userId,
      providerId: "anthropic",
      method: "POST",
      requestPath: "/api/v1/gateway/anthropic/v1/messages",
      search: "",
      headers,
      bodyText: requestBody("claude-test"),
    });
    assert.equal(first.status, 200);
    const afterFirst = await harness.runtime.billing.getSummary(harness.userId);

    // 同一个 request id 再来一次：按幂等冲突拒绝，且不重复转发/扣费
    const second = await harness.runtime.gateway.handle({
      userId: harness.userId,
      providerId: "anthropic",
      method: "POST",
      requestPath: "/api/v1/gateway/anthropic/v1/messages",
      search: "",
      headers,
      bodyText: requestBody("claude-test"),
    });
    assert.equal(second.status, 409);
    const secondBody = (await second.json()) as { error: { code: string } };
    assert.equal(secondBody.error.code, "duplicate_request");
    assert.equal(harness.forwarded.length, 1);

    const afterSecond = await harness.runtime.billing.getSummary(harness.userId);
    assert.equal(afterSecond.balanceMicros, afterFirst.balanceMicros);
  } finally {
    harness.runtime.dispose();
  }
});
