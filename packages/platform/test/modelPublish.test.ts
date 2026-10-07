/**
 * 模型发布测试（specs/platform/model-publish.md 验收）：
 * 设置校验、目录生成、设置往返、apply 的 revision 递增、网关显示名改写、HTTP 契约。
 *
 * 目录生成的产物额外用客户端自己的解码器在 scripts 侧校验（decodeZCodeBuiltinRelease），
 * 见 scripts/validate-platform-catalog.mjs；这里用结构断言覆盖两种保留模式。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelSettings, type ModelPublishSettings } from "../src/domain/modelPublish.js";
import { buildCatalog, nextRevision } from "../src/domain/modelPublishCatalog.js";
import { createModelPublishService } from "../src/app/modelPublishService.js";
import { createPlatformApp } from "../src/adapters/http/app.js";
import { createLogger } from "../src/adapters/log.js";
import type { CatalogRepository, ModelPublishRepository } from "../src/app/ports.js";
import type { CatalogService } from "../src/app/catalogService.js";
import { microsFromDecimalString } from "../src/domain/money.js";
import type { UpstreamTransport } from "../src/app/ports.js";
import { createTestRuntime } from "./helpers.js";

// ── 内存实现 ─────────────────────────────────────────────────

function createMemoryPublishRepository(): ModelPublishRepository {
  let stored: ModelPublishSettings | null = null;
  return {
    async readSettings() {
      return stored;
    },
    async writeSettings(settings) {
      stored = settings;
    },
    async findUpstreamModelId(providerId, clientModelId) {
      const provider = stored?.providers.find((item) => item.providerId === providerId);
      const model = provider?.models.find((item) => item.displayName === clientModelId);
      return model ? model.upstreamModelId : null;
    },
  };
}

function createMemoryCatalog(): CatalogRepository {
  const history = new Map<number, { revision: number; content: string }>();
  let current: { revision: number; content: string } | null = null;
  return {
    async readCurrent() {
      return current;
    },
    async readByRevision(revision) {
      return history.get(revision) ?? null;
    },
    async write({ content, revision, expectedRevision }) {
      if ((current?.revision ?? null) !== expectedRevision) {
        throw new Error(
          `期望 revision ${String(expectedRevision)}，当前 ${String(current?.revision ?? null)}`,
        );
      }
      // 与 sqlite 实现一致：按 revision 保留历史，客户端按固定 URL 取旧版本。
      history.set(revision, { revision, content });
      current = { revision, content };
      return revision;
    },
  };
}

/** 内置目录基线：只保留测试关心的最小形状（providerRules + 五个规则数组）。 */
const BUILTIN_BASE = {
  schemaVersion: 1,
  revision: 30,
  config: {
    providerConfigRules: {
      templateRules: [
        {
          templateId: "tpl:zai",
          templateNameMap: { "zh-CN": "智谱" },
          config: {
            builtinModelIds: ["GLM-5.3"],
            api: { type: "anthropic-messages", baseUrl: "https://zcode.z.ai/api/anthropic" },
          },
        },
      ],
      providerRules: [
        {
          providerId: "account:zai-start-plan",
          providerName: "Start Plan",
          config: {
            group: "zai-family",
            builtinModelIds: ["GLM-5.3-Flash"],
            access: { type: "zhipu-account", mode: "start-plan", accountType: "zai" },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
            },
          },
        },
      ],
    },
    modelConfigRules: {
      modelRules: [],
      modelApiRules: [
        {
          modelMatch: ".*",
          apiTypeMatch: "anthropic-messages",
          config: {
            optionSpecs: { reasoningLevel: { map: '{ "thinking": { "type": "adaptive" } }' } },
          },
        },
      ],
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [
        {
          providerId: "account:zai-start-plan",
          modelId: "GLM-5.3-Flash",
          config: { enabled: true },
        },
      ],
    },
  },
};

const VALID_SETTINGS = normalizeModelSettings({
  providers: [
    {
      providerId: "1",
      clientProtocol: "openai-chat-completions",
      models: [
        {
          upstreamModelId: "glm-5.3-free",
          displayName: "GLM-5.3 免费版",
          contextWindow: 200000,
          maxOutputTokens: 32768,
          supportsImage: true,
          supportsToolCall: true,
          reasoningLevels: ["disabled", "low", "high"],
        },
        { upstreamModelId: "glm-5.3-air" },
      ],
    },
  ],
});

function createFakeCatalogService(overrides: Partial<CatalogService> = {}): CatalogService {
  const catalog = createMemoryCatalog();
  const base: CatalogService = {
    async readCurrent() {
      return await catalog.readCurrent();
    },
    async readByRevision(revision) {
      return await catalog.readByRevision(revision);
    },
    summarize(content) {
      const parsed = JSON.parse(content) as { revision: number };
      return { revision: parsed.revision, providerCount: 1, modelCount: 1 };
    },
    async update(input) {
      const summary = base.summarize(input.content);
      if (summary.revision <= (await catalog.readCurrent())?.revision) {
        throw new Error("revision 必须递增");
      }
      return await catalog.write({
        content: input.content,
        revision: summary.revision,
        expectedRevision: input.expectedRevision,
        updatedBy: input.updatedBy,
        now: 0,
      });
    },
    async readBuiltin() {
      return { revision: BUILTIN_BASE.revision, content: JSON.stringify(BUILTIN_BASE) };
    },
    async buildClientConfigs(origin) {
      const current = await catalog.readCurrent();
      if (!current) throw new Error("尚未配置目录");
      return {
        code: 0,
        data: {
          configs: {
            builtin_provider_config_json: `${origin}/api/v1/catalog/${current.revision}.json`,
          },
        },
      };
    },
    async buildClientConfigsWithOperations(origin) {
      return await base.buildClientConfigs(origin);
    },
  };
  return { ...base, ...overrides };
}

const SERVICE_DEPS = () => ({
  publish: createMemoryPublishRepository(),
  providers: {
    async list() {
      return [
        {
          id: "1",
          label: "免费上游",
          upstreamBaseUrl: "https://free.test/v1",
          apiKey: "sk-real-secret",
          protocol: "openai" as const,
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ];
    },
    async findById(id: string) {
      return (await this.list()).find((provider) => provider.id === id) ?? null;
    },
    async upsert() {},
    async remove() {},
  },
  catalog: createFakeCatalogService(),
  getPublicOrigin: () => "https://platform.test",
  now: () => 1_000,
});

// ── normalizeModelSettings ───────────────────────────────────

test("设置校验：非法输入逐一被拒绝", () => {
  const cases: readonly [string, unknown][] = [
    ["协议非法", { providers: [{ providerId: "1", clientProtocol: "openai", models: [] }] }],
    [
      "providerId 为空",
      { providers: [{ providerId: "  ", clientProtocol: "anthropic-messages", models: [] }] },
    ],
    [
      "providerId 重复",
      {
        providers: [
          { providerId: "1", clientProtocol: "anthropic-messages", models: [] },
          { providerId: "1", clientProtocol: "anthropic-messages", models: [] },
        ],
      },
    ],
    [
      "显示名重复（同上游内）",
      {
        providers: [
          {
            providerId: "1",
            clientProtocol: "anthropic-messages",
            models: [
              { upstreamModelId: "a", displayName: "GLM" },
              { upstreamModelId: "b", displayName: " GLM " },
            ],
          },
        ],
      },
    ],
    [
      "上下文窗口非正整数",
      {
        providers: [
          {
            providerId: "1",
            clientProtocol: "anthropic-messages",
            models: [{ upstreamModelId: "a", contextWindow: 0 }],
          },
        ],
      },
    ],
    [
      "思考档位非法",
      {
        providers: [
          {
            providerId: "1",
            clientProtocol: "anthropic-messages",
            models: [{ upstreamModelId: "a", reasoningLevels: ["ultra"] }],
          },
        ],
      },
    ],
    [
      "能力不是布尔",
      {
        providers: [
          {
            providerId: "1",
            clientProtocol: "anthropic-messages",
            models: [{ upstreamModelId: "a", supportsImage: "yes" }],
          },
        ],
      },
    ],
  ];
  for (const [label, input] of cases) {
    assert.throws(
      () => normalizeModelSettings(input),
      (error: unknown) => error !== null && typeof error === "object" && "code" in error,
      `期望拒绝：${label}`,
    );
  }
});

test("设置校验：显示名缺省取上游模型 ID，空思考档位归一为 null", () => {
  const settings = normalizeModelSettings({
    providers: [
      {
        providerId: "1",
        clientProtocol: "anthropic-messages",
        models: [
          { upstreamModelId: "glm-air", reasoningLevels: [], supportsToolCall: undefined },
          { upstreamModelId: "glm-pro", displayName: "GLM Pro" },
        ],
      },
    ],
  });
  assert.equal(settings.providers[0]!.models[0]!.displayName, "glm-air");
  assert.equal(settings.providers[0]!.models[0]!.reasoningLevels, null);
  assert.equal(settings.providers[0]!.models[0]!.supportsToolCall, false);
  assert.equal(settings.providers[0]!.models[1]!.displayName, "GLM Pro");
});

// ── buildCatalog ─────────────────────────────────────────────

test("目录生成：显示名进入 builtinModelIds 与 builtinProviderModelRules，顺序保持，无真实 key、无 map", () => {
  const built = buildCatalog({
    settings: VALID_SETTINGS,
    builtinCatalog: BUILTIN_BASE,
    origin: "https://platform.test",
    revision: 31,
    keepBuiltinProviders: true,
    providerLabels: new Map([["1", "免费上游"]]),
  });
  const catalog = JSON.parse(built.content) as {
    revision: number;
    config: {
      providerConfigRules: { providerRules: Record<string, unknown>[] };
      modelConfigRules: { builtinProviderModelRules: Record<string, unknown>[] };
    };
  };
  assert.equal(catalog.revision, 31);
  const platform = catalog.config.providerConfigRules.providerRules.find(
    (rule) => rule["providerId"] === "platform:1",
  ) as Record<string, unknown> | undefined;
  assert.ok(platform, "缺少平台 provider");
  const config = platform["config"] as Record<string, unknown>;
  // 顺序即客户端展示顺序：第一个模型排在最前
  assert.deepEqual(config["builtinModelIds"], ["GLM-5.3 免费版", "glm-5.3-air"]);
  assert.equal(config["group"] as string, "zai-family");
  assert.equal(
    (config["api"] as Record<string, unknown>)["baseUrl"],
    "https://platform.test/api/v1/gateway/1",
  );
  assert.equal((config["api"] as Record<string, unknown>)["type"], "openai-chat-completions");
  // 占位 key 而不是真实 key：目录全站可下载
  assert.equal((config["access"] as Record<string, unknown>)["apiKey"], "platform-gateway-managed");
  assert.equal(built.content.includes("sk-real-secret"), false);

  const bindings = catalog.config.modelConfigRules.builtinProviderModelRules.filter(
    (rule) => rule["providerId"] === "platform:1",
  );
  assert.deepEqual(
    bindings.map((rule) => rule["modelId"]),
    ["GLM-5.3 免费版", "glm-5.3-air"],
  );
  const first = bindings[0]!["config"] as Record<string, unknown>;
  const properties = first["properties"] as Record<string, unknown>;
  assert.equal(properties["contextWindow"], 200000);
  assert.equal(properties["supportsToolCall"], true);
  const optionSpecs = first["optionSpecs"] as Record<string, unknown>;
  assert.deepEqual((optionSpecs["reasoningLevel"] as Record<string, unknown>)["values"], [
    "disabled",
    "low",
    "high",
  ]);
  // 生成层绝不写 map：映射以内置 modelApiRules 兜底为唯一事实源
  assert.equal((optionSpecs["reasoningLevel"] as Record<string, unknown>)["map"], undefined);
  // 第二个模型没配置输出上限，optionSpecs 整体缺省
  const second = bindings[1]!["config"] as Record<string, unknown>;
  assert.equal(
    "optionSpecs" in second
      ? (second["optionSpecs"] as Record<string, unknown>)["maxOutputTokens"]
      : undefined,
    undefined,
  );
});

test("目录生成：不保留内置 provider 时替换四类规则、保留兜底映射", () => {
  const built = buildCatalog({
    settings: VALID_SETTINGS,
    builtinCatalog: BUILTIN_BASE,
    origin: "https://platform.test",
    revision: 31,
    keepBuiltinProviders: false,
    providerLabels: new Map(),
  });
  const catalog = JSON.parse(built.content) as {
    config: {
      providerConfigRules: { providerRules: Record<string, unknown>[]; templateRules: unknown[] };
      modelConfigRules: {
        builtinProviderModelRules: Record<string, unknown>[];
        templateModelRules: unknown[];
        modelApiRules: unknown[];
      };
    };
  };
  const providerIds = catalog.config.providerConfigRules.providerRules.map(
    (rule) => rule["providerId"],
  );
  assert.deepEqual(providerIds, ["platform:1"]);
  assert.deepEqual(catalog.config.providerConfigRules.templateRules, []);
  assert.deepEqual(catalog.config.modelConfigRules.templateModelRules, []);
  // 兜底思考参数映射必须保留，否则显示名再对也调不出思考档位
  assert.equal(catalog.config.modelConfigRules.modelApiRules.length, 1);
  assert.deepEqual(
    catalog.config.modelConfigRules.builtinProviderModelRules.map((rule) => rule["providerId"]),
    ["platform:1", "platform:1"],
  );
});

test("目录生成：keep=true 时与内置 provider 重名报错；非 https origin 报错", () => {
  // 基线里手工放一个与平台命名规则撞名的 provider（比如曾被手动编辑过的目录）。
  const baseWithCollision = structuredClone(BUILTIN_BASE);
  baseWithCollision.config.providerConfigRules.providerRules.push({
    providerId: "platform:1",
    providerName: "遗留条目",
    config: {
      group: "zai-family",
      builtinModelIds: ["legacy"],
      api: { type: "anthropic-messages", baseUrl: "https://legacy.test" },
    },
  });
  assert.throws(
    () =>
      buildCatalog({
        settings: VALID_SETTINGS,
        builtinCatalog: baseWithCollision,
        origin: "https://platform.test",
        revision: 31,
        keepBuiltinProviders: true,
        providerLabels: new Map(),
      }),
    /platform:1/,
  );
  assert.throws(
    () =>
      buildCatalog({
        settings: VALID_SETTINGS,
        builtinCatalog: BUILTIN_BASE,
        origin: "http://127.0.0.1:3100",
        revision: 31,
        keepBuiltinProviders: true,
        providerLabels: new Map(),
      }),
    /https/,
  );
});

test("revision 下限：客户端内置目录是 30，首次推送必须 ≥ 31", () => {
  assert.equal(nextRevision(null), 31);
  assert.equal(nextRevision(0), 31);
  assert.equal(nextRevision(30), 31);
  assert.equal(nextRevision(31), 32);
});

// ── 服务：保存往返 + preview/apply ───────────────────────────

test("服务：保存设置往返一致，apply 递增 revision 且能按 revision 取回", async () => {
  const deps = SERVICE_DEPS();
  const service = createModelPublishService(deps);
  const saved = await service.saveSettings({
    settings: VALID_SETTINGS,
    updatedBy: "admin-1",
  });
  const reloaded = await service.readSettings();
  assert.deepEqual(reloaded, saved);

  const preview = await service.preview({ keepBuiltinProviders: true });
  assert.equal(preview.revision, 31);
  assert.equal(preview.summary.modelCount, 2);

  const applied = await service.apply({ keepBuiltinProviders: true, updatedBy: "admin-1" });
  assert.equal(applied.revision, 31);
  const current = await deps.catalog.readCurrent();
  assert.equal(current?.revision, 31);
  // 推送第二版：revision 再次递增
  const second = await service.apply({ keepBuiltinProviders: true, updatedBy: "admin-1" });
  assert.equal(second.revision, 32);
  const reread = await deps.catalog.readByRevision(31);
  assert.ok(reread, "旧 revision 应可取回");
});

test("服务：没有保存任何模型时 apply/preview 被拒绝", async () => {
  const service = createModelPublishService(SERVICE_DEPS());
  await assert.rejects(
    () => service.apply({ keepBuiltinProviders: true, updatedBy: null }),
    /保存/,
  );
  await assert.rejects(() => service.preview({ keepBuiltinProviders: true }), /保存/);
});

test("服务：origin 未配置时拒绝推送", async () => {
  const deps = { ...SERVICE_DEPS(), getPublicOrigin: () => null };
  const service = createModelPublishService(deps);
  await service.saveSettings({ settings: VALID_SETTINGS, updatedBy: null });
  await assert.rejects(
    () => service.apply({ keepBuiltinProviders: true, updatedBy: null }),
    /ZCODE_PLATFORM_PUBLIC_ORIGIN/,
  );
});

// ── 网关：显示名 → 上游真实 ID 改写 ──────────────────────────

test("网关：显示名请求被改写为上游真实 ID，用量按真实 ID 记账；未映射的原样透传", async () => {
  const forwarded: { url: string; body: string | null }[] = [];
  const transport: UpstreamTransport = {
    async forward(request) {
      forwarded.push({ url: request.url, body: request.body });
      return new Response(
        JSON.stringify({ usage: { input_tokens: 1_000_000, output_tokens: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
  const runtime = await createTestRuntime({}, { upstreamTransport: transport });
  try {
    const user = await runtime.accounts.createUser({
      email: "user@example.com",
      password: "initial-password",
    });
    await runtime.repositories.providers.upsert({
      id: "1",
      label: "免费上游",
      upstreamBaseUrl: "https://upstream.test/v1",
      apiKey: "sk-upstream-secret",
      protocol: "openai",
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    });
    await runtime.repositories.prices.upsert({
      modelId: "glm-5.3-free",
      inputMicrosPerMillion: microsFromDecimalString("3"),
      outputMicrosPerMillion: microsFromDecimalString("15"),
      cacheReadMicrosPerMillion: 0,
      cacheWriteMicrosPerMillion: 0,
      updatedAt: 0,
    });
    await runtime.billing.recharge({
      userId: user.id,
      amountMicros: microsFromDecimalString("100"),
    });
    await runtime.repositories.publish.writeSettings(
      normalizeModelSettings({
        providers: [
          {
            providerId: "1",
            clientProtocol: "openai-chat-completions",
            models: [{ upstreamModelId: "glm-5.3-free", displayName: "GLM-5.3 免费版" }],
          },
        ],
      }),
      { updatedBy: null, now: 0 },
    );

    const headers = new Headers({ "content-type": "application/json" });
    // 客户端发的 model 是显示名
    const response = await runtime.gateway.handle({
      userId: user.id,
      providerId: "1",
      method: "POST",
      requestPath: "/api/v1/gateway/1/v1/chat/completions",
      search: "",
      headers,
      bodyText: JSON.stringify({
        model: "GLM-5.3 免费版",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(forwarded.length, 1);
    const forwardedBody = JSON.parse(forwarded[0]!.body ?? "{}") as { model?: string };
    // 上游收到的是真实模型 ID，显示名绝不出现在转发请求里
    assert.equal(forwardedBody.model, "glm-5.3-free");

    // 未映射的模型（老客户端直发真实 ID）原样透传，行为不变
    const passthrough = await runtime.gateway.handle({
      userId: user.id,
      providerId: "1",
      method: "POST",
      requestPath: "/api/v1/gateway/1/v1/chat/completions",
      search: "",
      headers,
      bodyText: JSON.stringify({ model: "glm-5.3-free", max_tokens: 100, messages: [] }),
    });
    assert.equal(passthrough.status, 200);
    const passthroughBody = JSON.parse(forwarded[1]!.body ?? "{}") as { model?: string };
    assert.equal(passthroughBody.model, "glm-5.3-free");

    // 用量按真实 ID 记账（结算后可查）
    const records = await runtime.repositories.usage.list({ limit: 10, offset: 0 });
    assert.equal(records.length, 2);
    assert.equal(records[0]!.modelId, "glm-5.3-free");
  } finally {
    runtime.dispose();
  }
});

// ── HTTP 契约 ────────────────────────────────────────────────

test("HTTP：发布设置保存往返、apply 递增 revision、目录可按 revision 取回", async () => {
  const runtime = await createTestRuntime();
  try {
    await runtime.accounts.createUser({
      email: "admin@example.com",
      password: "admin-password",
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
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "admin-password" }),
    });
    const token = ((await login.json()) as { token: string }).token;
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const put = await app.request("/api/admin/publish", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        providers: [
          {
            providerId: "1",
            clientProtocol: "openai-chat-completions",
            models: [{ upstreamModelId: "glm-5.3-free", displayName: "GLM-5.3 免费版" }],
          },
        ],
      }),
    });
    assert.equal(put.status, 200);

    const get = await app.request("/api/admin/publish", { headers: auth });
    assert.equal(get.status, 200);
    const state = (await get.json()) as { providers: { models: { displayName: string }[] }[] };
    assert.equal(state.providers[0]!.models[0]!.displayName, "GLM-5.3 免费版");

    // 需要先有上游 provider（目录里的网关地址背后要有真实上游）
    await runtime.repositories.providers.upsert({
      id: "1",
      label: "免费上游",
      upstreamBaseUrl: "https://upstream.test/v1",
      apiKey: "sk-upstream-secret",
      protocol: "openai",
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    });
    const apply = await app.request("/api/admin/publish/apply", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ keepBuiltinProviders: true }),
    });
    assert.equal(apply.status, 200);
    const { revision } = (await apply.json()) as { revision: number };
    assert.ok(revision >= 31, "revision 必须大于内置目录的 30");

    const catalogResponse = await app.request(`/api/v1/catalog/${revision}.json`);
    assert.equal(catalogResponse.status, 200);
    const catalog = (await catalogResponse.json()) as {
      revision: number;
      config: { providerConfigRules: { providerRules: Record<string, unknown>[] } };
    };
    assert.equal(catalog.revision, revision);
    const platform = catalog.config.providerConfigRules.providerRules.find(
      (rule) => rule["providerId"] === "platform:1",
    );
    assert.ok(platform, "目录里缺少平台 provider");

    // 客户端入口返回新目录地址
    const configs = await app.request("/api/v1/client/configs");
    const payload = (await configs.json()) as {
      data: { configs: { builtin_provider_config_json: string } };
    };
    assert.equal(
      payload.data.configs.builtin_provider_config_json,
      `https://platform.test/api/v1/catalog/${revision}.json`,
    );
  } finally {
    runtime.dispose();
  }
});
