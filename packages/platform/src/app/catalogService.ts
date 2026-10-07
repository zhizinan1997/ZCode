/**
 * 模型目录用例。
 *
 * 目录是**全站共享**的一份 JSON：客户端定期拉取，管理员改完不需要发新版。
 * 因此保存前必须做结构校验——把不可解析的目录推给全部客户端，等于让所有人同时失去模型列表。
 *
 * 注意校验强度：这里只做结构与关键字段校验（schemaVersion / revision / provider 的 baseUrl）。
 * 客户端用的是严格 schema，多余的未知字段会被它拒绝；平台无法完全复刻那份 schema，
 * 所以新增字段前仍要先发客户端（见 specs/platform/model-catalog.md）。
 */
import { PlatformError } from "../domain/errors.js";
import type { CatalogRepository } from "./ports.js";

export interface CatalogContentSummary {
  readonly revision: number;
  readonly providerCount: number;
  readonly modelCount: number;
}

export interface CatalogService {
  readCurrent(): Promise<{ revision: number; content: string } | null>;
  readByRevision(revision: number): Promise<{ revision: number; content: string } | null>;
  summarize(content: string): CatalogContentSummary;
  update(input: {
    content: string;
    expectedRevision: number | null;
    updatedBy: string | null;
  }): Promise<number>;
  /** 客户端 /api/v1/client/configs 的响应体。 */
  buildClientConfigs(origin: string): Promise<Record<string, unknown>>;
}

const CATALOG_PATH_PREFIX = "/api/v1/catalog";

export function buildCatalogUrl(origin: string, revision: number): string {
  const normalized = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return `${normalized}${CATALOG_PATH_PREFIX}/${revision}.json`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformError("invalid_request", `${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

/**
 * 校验目录并返回摘要。
 *
 * 形状必须与客户端的严格 schema 一致（见 packages/provider-node/src/zcode-builtin-release.ts）：
 *   { schemaVersion: 1, revision: <int>, config: { providerConfigRules, modelConfigRules } }
 * `config` 只允许这两个键——内容全部嵌在 `config` 下，**不是**放在顶层。
 * 这里只做结构与关键字段校验；客户端还有更细的规则，因此新增 provider 的目录
 * 应当用 scripts/build-platform-catalog.mjs 生成（它会用客户端的解码器自校验）。
 *
 * 抛出的错误直接面向管理员，因此要说清是哪一项不合法，而不是只说"格式错误"。
 */
function parseAndValidate(content: string): CatalogContentSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new PlatformError("invalid_request", "目录不是合法 JSON", { cause: error });
  }
  const root = asRecord(parsed, "目录");
  if (root["schemaVersion"] !== 1) {
    throw new PlatformError("invalid_request", "目录的 schemaVersion 必须为 1");
  }
  const revision = root["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0) {
    throw new PlatformError("invalid_request", "目录的 revision 必须是正整数");
  }

  if (root["providerConfigRules"] !== undefined) {
    throw new PlatformError(
      "invalid_request",
      "providerConfigRules 必须放在 config 下：客户端要求顶层是 { schemaVersion, revision, config }",
    );
  }
  const config = asRecord(root["config"], "目录的 config");
  const unknownKeys = Object.keys(config).filter(
    (key) => key !== "providerConfigRules" && key !== "modelConfigRules",
  );
  if (unknownKeys.length > 0) {
    // 客户端的 config 是严格对象，多余键会让整份目录被拒绝。
    throw new PlatformError(
      "invalid_request",
      `config 只允许 providerConfigRules 与 modelConfigRules，多出：${unknownKeys.join(", ")}`,
    );
  }

  const rules = asRecord(config["providerConfigRules"], "config.providerConfigRules");
  const providerRules = rules["providerRules"];
  if (!Array.isArray(providerRules)) {
    throw new PlatformError("invalid_request", "config.providerConfigRules.providerRules 必须是数组");
  }
  if (!Array.isArray(asRecord(config["modelConfigRules"], "config.modelConfigRules")["modelRules"])) {
    throw new PlatformError("invalid_request", "config.modelConfigRules.modelRules 必须是数组");
  }

  let modelCount = 0;
  for (const entry of providerRules) {
    const rule = asRecord(entry, "providerRules 条目");
    const providerId = rule["providerId"];
    if (typeof providerId !== "string" || !providerId.trim()) {
      throw new PlatformError("invalid_request", "providerRules 条目缺少 providerId");
    }
    const providerConfig = asRecord(rule["config"], `provider ${providerId} 的 config`);
    const api = asRecord(providerConfig["api"], `provider ${providerId} 的 config.api`);
    const baseUrl = api["baseUrl"];
    if (typeof baseUrl !== "string" || !baseUrl.trim()) {
      throw new PlatformError(
        "invalid_request",
        `provider ${providerId} 缺少 config.api.baseUrl：客户端会不知道该往哪里发请求`,
      );
    }
    const models = rule["models"];
    if (Array.isArray(models)) {
      modelCount += models.length;
    }
  }

  return { revision, providerCount: providerRules.length, modelCount };
}

export function createCatalogService(deps: {
  readonly catalog: CatalogRepository;
  readonly now: () => number;
}): CatalogService {
  return {
    async readCurrent() {
      return await deps.catalog.readCurrent();
    },

    async readByRevision(revision) {
      return await deps.catalog.readByRevision(revision);
    },

    summarize(content) {
      return parseAndValidate(content);
    },

    async update({ content, expectedRevision, updatedBy }) {
      const summary = parseAndValidate(content);
      const current = await deps.catalog.readCurrent();
      const currentRevision = current?.revision ?? 0;
      if (summary.revision <= currentRevision) {
        // revision 不递增客户端根本不会应用新目录，静默接受只会让管理员以为改成功了。
        throw new PlatformError(
          "invalid_request",
          `目录 revision 必须大于当前值 ${currentRevision}，收到 ${summary.revision}`,
        );
      }
      return await deps.catalog.write({
        content,
        revision: summary.revision,
        expectedRevision,
        updatedBy,
        now: deps.now(),
      });
    },

    async buildClientConfigs(origin) {
      const current = await deps.catalog.readCurrent();
      if (!current) {
        // 还没导入目录时不能返回空对象：客户端会当成"远端没有配置"而回退到随包内置目录，
        // 那里面全是厂商地址。宁可让这次请求失败，让管理员先去导入目录。
        throw new PlatformError("not_found", "平台尚未配置模型目录，请在管理后台导入");
      }
      const catalogUrl = buildCatalogUrl(origin, current.revision);
      // 客户端的 schema 要求两件事，缺一不可（见 packages/provider-node/src/zcode-builtin-download.ts）：
      //   1. 信封里有 `code: 0`（字面量 0，不是"任意数字"）；
      //   2. 目录地址是 https 且不带凭据——http 的地址会被客户端直接拒绝。
      // 因此生产部署必须用 https 域名，否则客户端拿不到模型目录。
      if (!catalogUrl.startsWith("https://")) {
        throw new PlatformError(
          "invalid_request",
          `客户端只接受 https 的模型目录地址，当前站点地址是 ${origin}。` +
            "请把 ZCODE_PLATFORM_PUBLIC_ORIGIN 配成 https 域名（反向代理终止 TLS 即可）。",
        );
      }
      return {
        code: 0,
        data: {
          configs: {
            builtin_provider_config_json: catalogUrl,
          },
        },
      };
    },
  };
}
