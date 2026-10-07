/** 模型目录与客户端发布的校验与生成规则。 */
import assert from "node:assert/strict";
import test from "node:test";
import { createCatalogService, buildCatalogUrl } from "../src/app/catalogService.js";
import { createReleaseService } from "../src/app/releaseService.js";
import { PlatformError } from "../src/domain/errors.js";
import { compareVersions } from "../src/domain/releases.js";
import type { CatalogRepository, ReleaseRepository } from "../src/app/ports.js";
import type { ReleaseRecord } from "../src/domain/releases.js";

function createMemoryCatalog(): CatalogRepository {
  let current: { revision: number; content: string } | null = null;
  return {
    async readCurrent() {
      return current;
    },
    async readByRevision(revision) {
      return current && current.revision === revision ? current : null;
    },
    async write({ content, revision, expectedRevision }) {
      const actual = current?.revision ?? null;
      if (actual !== expectedRevision) {
        throw new PlatformError("conflict", "目录已被其他修改更新");
      }
      current = { revision, content };
      return revision;
    },
  };
}

function validCatalog(
  revision: number,
  baseUrl = "https://platform.test/api/v1/gateway/anthropic",
): string {
  return JSON.stringify({
    schemaVersion: 1,
    revision,
    // 内容全部嵌在 config 下，与客户端的严格 schema 一致
    config: {
      providerConfigRules: {
        templateRules: [],
        providerRules: [
          {
            providerId: "anthropic",
            providerName: "Anthropic",
            // 客户端严格 schema 里 provider 的可见模型清单是 config.builtinModelIds（审计#20）
            config: {
              api: { type: "anthropic-messages", baseUrl },
              builtinModelIds: ["claude-test"],
            },
          },
        ],
      },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  });
}

test("目录校验：合法目录返回摘要", () => {
  const service = createCatalogService({ catalog: createMemoryCatalog(), now: () => 0 });
  const summary = service.summarize(validCatalog(1));
  assert.deepEqual(summary, { revision: 1, providerCount: 1, modelCount: 1 });
});

test("目录摘要：模型数统计 config.builtinModelIds 而不是条目上的 models 字段（审计#20）", () => {
  const service = createCatalogService({ catalog: createMemoryCatalog(), now: () => 0 });
  // 两个 provider、各带两个模型；其中一份还带着旧实现误读的 models 字段（客户端严格 schema
  // 里没有它，但平台侧宽松校验只按真实字段统计，不因多余字段拒绝）。
  const content = JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    config: {
      providerConfigRules: {
        templateRules: [],
        providerRules: [
          {
            providerId: "a",
            config: {
              api: { type: "anthropic-messages", baseUrl: "https://a.test" },
              builtinModelIds: ["m1", "m2"],
            },
          },
          {
            providerId: "b",
            models: [{ modelId: "legacy" }],
            config: {
              api: { type: "openai-chat-completions", baseUrl: "https://b.test" },
              builtinModelIds: ["m3", "m4"],
            },
          },
        ],
      },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  });
  assert.deepEqual(service.summarize(content), { revision: 1, providerCount: 2, modelCount: 4 });
});

test("目录摘要：builtinModelIds 不是字符串数组时拒绝（客户端会整份拒绝）", () => {
  const service = createCatalogService({ catalog: createMemoryCatalog(), now: () => 0 });
  const broken = JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    config: {
      providerConfigRules: {
        templateRules: [],
        providerRules: [
          {
            providerId: "a",
            config: {
              api: { type: "anthropic-messages", baseUrl: "https://a.test" },
              builtinModelIds: ["m1", 42],
            },
          },
        ],
      },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  });
  assert.throws(
    () => service.summarize(broken),
    (error: unknown) =>
      error instanceof PlatformError && /builtinModelIds 必须是非空字符串数组/.test(error.message),
  );
});

test("目录校验：顶层出现 providerConfigRules 会被拒绝（必须嵌在 config 下）", () => {
  const service = createCatalogService({ catalog: createMemoryCatalog(), now: () => 0 });
  // 这是最容易犯的错：内容写对了，但少了一层 config 包裹，
  // 客户端会报 invalid schema at config，而平台如果不拦就会把它推给所有人。
  const wrong = JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { modelRules: [] },
  });
  assert.throws(
    () => service.summarize(wrong),
    (error: unknown) => error instanceof PlatformError && /必须放在 config 下/.test(error.message),
  );
});

test("目录校验：config 下的未知键会被拒绝（客户端 config 是严格对象）", () => {
  const service = createCatalogService({ catalog: createMemoryCatalog(), now: () => 0 });
  const withExtra = JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { modelRules: [] },
      somethingElse: true,
    },
  });
  assert.throws(
    () => service.summarize(withExtra),
    (error: unknown) => error instanceof PlatformError && /多出：somethingElse/.test(error.message),
  );
});

test("目录校验：schemaVersion、revision、baseUrl 都必须合法", () => {
  const service = createCatalogService({ catalog: createMemoryCatalog(), now: () => 0 });
  const cases: readonly [string, string][] = [
    ["不是 JSON", "{broken"],
    [
      "schemaVersion 非 1",
      JSON.stringify({
        schemaVersion: 2,
        revision: 1,
        config: {
          providerConfigRules: { providerRules: [] },
          modelConfigRules: { modelRules: [] },
        },
      }),
    ],
    [
      "revision 非正整数",
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        config: {
          providerConfigRules: { providerRules: [] },
          modelConfigRules: { modelRules: [] },
        },
      }),
    ],
    [
      "providerRules 不是数组",
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: { providerRules: {} },
          modelConfigRules: { modelRules: [] },
        },
      }),
    ],
    [
      "modelRules 缺失",
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: { providerConfigRules: { providerRules: [] }, modelConfigRules: {} },
      }),
    ],
    [
      "provider 缺 baseUrl",
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: { providerRules: [{ providerId: "x", config: { api: {} } }] },
          modelConfigRules: { modelRules: [] },
        },
      }),
    ],
    [
      "provider 缺 providerId",
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: {
            providerRules: [{ config: { api: { baseUrl: "https://a.test" } } }],
          },
          modelConfigRules: { modelRules: [] },
        },
      }),
    ],
  ];
  for (const [label, content] of cases) {
    assert.throws(
      () => service.summarize(content),
      (error: unknown) => error instanceof PlatformError && error.code === "invalid_request",
      `期望拒绝：${label}`,
    );
  }
});

test("目录 revision 必须递增：不递增客户端根本不会应用", async () => {
  const catalog = createMemoryCatalog();
  const service = createCatalogService({ catalog, now: () => 0 });
  await service.update({ content: validCatalog(5), expectedRevision: null, updatedBy: null });
  assert.equal((await service.readCurrent())?.revision, 5);

  await assert.rejects(
    () => service.update({ content: validCatalog(5), expectedRevision: 5, updatedBy: null }),
    /必须大于/,
  );
  await assert.rejects(
    () => service.update({ content: validCatalog(3), expectedRevision: 5, updatedBy: null }),
    /必须大于/,
  );
  const next = await service.update({
    content: validCatalog(6),
    expectedRevision: 5,
    updatedBy: null,
  });
  assert.equal(next, 6);
});

test("revision 下限包含内置目录 revision：库内为空也不接受低于内置的 revision（审计#20）", async () => {
  const catalog = createMemoryCatalog();
  // 与真实部署一致：内置目录 revision 是 30（config/provider/zcode-builtin.json）。
  const service = createCatalogService({
    catalog,
    now: () => 0,
    builtin: { revision: 30, content: "{}" },
  });
  // 客户端在内置（30）与远程之间取较大者：revision 30 及以下永远不会生效。
  await assert.rejects(
    () => service.update({ content: validCatalog(30), expectedRevision: null, updatedBy: null }),
    (error: unknown) =>
      error instanceof PlatformError &&
      /必须大于 30（当前值与内置目录 revision 的较大者）/.test(error.message),
  );
  await assert.rejects(
    () => service.update({ content: validCatalog(29), expectedRevision: null, updatedBy: null }),
    /必须大于 30/,
  );
  const written = await service.update({
    content: validCatalog(31),
    expectedRevision: null,
    updatedBy: null,
  });
  assert.equal(written, 31);
});

test("revision 下限取库内当前值与内置 revision 的较大者", async () => {
  const catalog = createMemoryCatalog();
  const service = createCatalogService({
    catalog,
    now: () => 0,
    builtin: { revision: 30, content: "{}" },
  });
  // 库内已经推到 40：下限跟随库内当前值，而不是被内置 revision 拉回去。
  await service.update({ content: validCatalog(40), expectedRevision: null, updatedBy: null });
  await assert.rejects(
    () => service.update({ content: validCatalog(40), expectedRevision: 40, updatedBy: null }),
    /必须大于 40/,
  );
  const written = await service.update({
    content: validCatalog(41),
    expectedRevision: 40,
    updatedBy: null,
  });
  assert.equal(written, 41);
});

test("并发编辑：expectedRevision 不匹配时拒绝覆盖", async () => {
  const catalog = createMemoryCatalog();
  const service = createCatalogService({ catalog, now: () => 0 });
  await service.update({ content: validCatalog(1), expectedRevision: null, updatedBy: null });
  await assert.rejects(
    () => service.update({ content: validCatalog(2), expectedRevision: null, updatedBy: null }),
    /已被其他修改更新/,
  );
});

test("未导入目录时客户端配置接口报错，而不是返回空配置", async () => {
  const service = createCatalogService({ catalog: createMemoryCatalog(), now: () => 0 });
  await assert.rejects(
    () => service.buildClientConfigs("https://platform.test"),
    /尚未配置模型目录/,
  );
});

test("客户端配置的信封与地址都必须满足客户端 schema", async () => {
  const catalog = createMemoryCatalog();
  const service = createCatalogService({ catalog, now: () => 0 });
  await service.update({ content: validCatalog(1), expectedRevision: null, updatedBy: null });
  const payload = (await service.buildClientConfigs("https://platform.test/")) as {
    code: number;
    data: { configs: { builtin_provider_config_json: string } };
  };
  // 客户端 schema 要求 code 字面量为 0（见 zcode-builtin-download.ts），少了它整段会被判非法
  assert.equal(payload.code, 0);
  assert.equal(
    payload.data.configs.builtin_provider_config_json,
    "https://platform.test/api/v1/catalog/1.json",
  );
  assert.equal(buildCatalogUrl("https://a.test", 7), "https://a.test/api/v1/catalog/7.json");
});

test("http 站点地址被拒绝：客户端只接受 https 的目录地址", async () => {
  const catalog = createMemoryCatalog();
  const service = createCatalogService({ catalog, now: () => 0 });
  await service.update({ content: validCatalog(1), expectedRevision: null, updatedBy: null });
  await assert.rejects(
    () => service.buildClientConfigs("http://127.0.0.1:3100"),
    /只接受 https 的模型目录地址/,
  );
});

function createMemoryReleases(): ReleaseRepository {
  const records: ReleaseRecord[] = [];
  return {
    async upsert(record) {
      const index = records.findIndex(
        (item) =>
          item.version === record.version &&
          item.platform === record.platform &&
          item.channel === record.channel,
      );
      if (index >= 0) {
        records[index] = record;
      } else {
        records.push(record);
      }
    },
    async list() {
      return [...records];
    },
    async listByTag({ channel, platform }) {
      return records.filter((item) => item.channel === channel && item.platform === platform);
    },
    async findById(id) {
      return records.find((item) => item.id === id) ?? null;
    },
    async remove(id) {
      const index = records.findIndex((item) => item.id === id);
      if (index >= 0) records.splice(index, 1);
    },
  };
}

const VALID_SHA512 = Buffer.alloc(64, 1).toString("base64");

test("发布：sha512 必须是 base64 的 64 字节摘要", async () => {
  const releases = createMemoryReleases();
  const service = createReleaseService({ releases, now: () => 1_000, newReleaseId: () => "rel_1" });
  const base = {
    version: "3.15.0",
    channel: "stable" as const,
    platform: "windows-x86_64",
    fileName: "ZCode-3.15.0-win-x64.exe",
    sha512: VALID_SHA512,
  };
  await service.upsert(base);

  await assert.rejects(
    () => service.upsert({ ...base, sha512: "not-base64-of-right-length" }),
    /base64 编码的 64 字节摘要/,
  );
  await assert.rejects(() => service.upsert({ ...base, version: "abc" }), /版本号格式不正确/);
  await assert.rejects(
    () => service.upsert({ ...base, fileName: "../evil.exe" }),
    /不能包含路径分隔符/,
  );
});

test("manifest：包含 version 与 sha512，URL 是相对路径", async () => {
  const releases = createMemoryReleases();
  const service = createReleaseService({ releases, now: () => 1_000, newReleaseId: () => "rel_1" });
  await service.upsert({
    version: "3.15.0",
    channel: "stable",
    platform: "windows-x86_64",
    fileName: "ZCode-3.15.0-win-x64.exe",
    sha512: VALID_SHA512,
    sizeBytes: 1234,
    releaseNotes: "修了几个问题\n还有第二行",
  });

  const manifest = await service.buildManifest({
    platform: "windows-x86_64",
    channel: "stable",
  });
  assert.ok(manifest);
  assert.match(manifest, /^version: "3\.15\.0"$/m);
  assert.match(manifest, /url: "\/releases\/electron\/3\.15\.0\/ZCode-3\.15\.0-win-x64\.exe"/);
  assert.ok(manifest.includes(`sha512: "${VALID_SHA512}"`));
  // 换行必须被转义成合法 YAML 双引号标量，否则解析会断在第二行
  assert.ok(manifest.includes("\\n"));
  assert.equal(manifest.includes("\n还有第二行"), false);
});

test("manifest：没有该平台该通道的发布时返回 null", async () => {
  const service = createReleaseService({
    releases: createMemoryReleases(),
    now: () => 1_000,
    newReleaseId: () => "rel_1",
  });
  assert.equal(
    await service.buildManifest({ platform: "darwin-aarch64", channel: "stable" }),
    null,
  );
});

test("manifest：同平台多版本取版本号最大的", async () => {
  const releases = createMemoryReleases();
  const service = createReleaseService({ releases, now: () => 1_000, newReleaseId: () => "rel_1" });
  for (const version of ["3.9.0", "3.15.0", "3.10.0"]) {
    await service.upsert({
      version,
      channel: "stable",
      platform: "windows-x86_64",
      fileName: `ZCode-${version}.exe`,
      sha512: VALID_SHA512,
    });
  }
  const manifest = await service.buildManifest({ platform: "windows-x86_64", channel: "stable" });
  assert.match(String(manifest), /^version: "3\.15\.0"$/m);
});

test("版本比较按数值而非字典序", () => {
  assert.equal(compareVersions("3.15.0", "3.9.0"), 1);
  assert.equal(compareVersions("3.9.0", "3.15.0"), -1);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.10", "1.2.9"), 1);
});
