/**
 * 模型发布的领域规则（纯函数，无 IO）。
 *
 * 管理员在后台按上游勾选模型、编辑显示名与能力；apply 时把它们与内置目录
 * （config/provider/zcode-builtin.json）合成为客户端严格 schema 的目录。
 *
 * 显示名即客户端模型 ID：客户端的模型选择器直接显示 modelId，目录 schema 没有
 * "显示名"字段，因此管理员配置的显示名会作为 modelId 写进目录；上游真实模型 ID
 * 只留在平台的 published_models 表里，由网关在转发时改写回去（见 gatewayService）。
 * specs/platform/model-publish.md 是这套规则的产品定义。
 *
 * 目录生成（buildCatalog）在 modelPublishCatalog.ts，二者共享本文件的类型与常量。
 */
import { PlatformError } from "./errors.js";

/** 客户端协议：与客户端 providerApiTypeDataSchema 的取值一致（注意与网关上游协议是两回事）。 */
export const CLIENT_PROTOCOLS = [
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
] as const;
export type ClientProtocol = (typeof CLIENT_PROTOCOLS)[number];

export function isClientProtocol(value: unknown): value is ClientProtocol {
  return typeof value === "string" && (CLIENT_PROTOCOLS as readonly string[]).includes(value);
}

/**
 * 后台可勾选的思考档位。档位值是数据不是 schema（客户端对 values 只要求非空且不重复），
 * 这里固定一组供管理员勾选；一个都不勾时不下发 values，客户端走内置 modelApiRules 兜底。
 */
export const REASONING_LEVEL_OPTIONS = [
  "disabled",
  "enabled",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** 目录里 access.apiKey 的占位值：客户端把它发给网关，网关换成真正的上游 key。 */
export const PLATFORM_ACCESS_PLACEHOLDER = "platform-gateway-managed";

/** 平台自有 provider 在目录里的 id 前缀；与内置的 account:* 命名风格一致且不会撞名。 */
export const PLATFORM_PROVIDER_ID_PREFIX = "platform:";

/** 客户端随包内置目录的 revision；平台首次下发必须严格大于它才会被应用。 */
export const BUILTIN_CATALOG_REVISION = 30;

export interface PublishedModelSetting {
  /** 上游真实模型 ID；绝不写入目录。 */
  readonly upstreamModelId: string;
  /** 客户端展示与请求使用的模型 ID（显示名）。 */
  readonly displayName: string;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly supportsImage: boolean;
  readonly supportsPdf: boolean;
  readonly supportsVideo: boolean;
  readonly supportsAudio: boolean;
  readonly supportsToolCall: boolean;
  /** null 表示不配置档位列表（客户端走内置兜底）。 */
  readonly reasoningLevels: string[] | null;
}

export interface PublishedProviderSetting {
  /** gateway_providers 表的 id（网关路径与映射都用它）。 */
  readonly providerId: string;
  readonly clientProtocol: ClientProtocol;
  /** 数组顺序即客户端展示顺序。 */
  readonly models: PublishedModelSetting[];
}

export interface ModelPublishSettings {
  readonly providers: PublishedProviderSetting[];
}

/** 领域内共用的校验失败助手；modelPublishCatalog 也用它保持错误口径一致。 */
export function fail(message: string): never {
  throw new PlatformError("invalid_request", message);
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function readTrimmed(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    fail(`${label} 必须是字符串`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    fail(`${label} 不能为空`);
  }
  if (trimmed.length > maxLength) {
    fail(`${label} 过长（最多 ${maxLength} 字符）`);
  }
  return trimmed;
}

function readOptionalPositiveInt(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} 必须是正整数或留空`);
  }
  return value;
}

function readOptionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    fail(`${label} 必须是布尔值`);
  }
  return value;
}

function readReasoningLevels(value: unknown): string[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    fail("思考档位必须是数组");
  }
  const levels: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !(REASONING_LEVEL_OPTIONS as readonly string[]).includes(item)
    ) {
      fail(`思考档位取值非法，允许：${REASONING_LEVEL_OPTIONS.join(", ")}`);
    }
    if (!levels.includes(item)) {
      levels.push(item);
    }
  }
  // 全不勾 = 不配置，与"未设置"同义，避免存一个空数组这种第三种状态。
  return levels.length > 0 ? levels : null;
}

/**
 * 校验并规范化发布设置。保存与 apply 前都必须过这里：错误信息直接面向管理员，
 * 要说清是哪个上游哪个模型的问题。display name 缺省等于上游模型 ID（管理员没改就是原样发布）。
 */
export function normalizeModelSettings(input: unknown): ModelPublishSettings {
  if (input === undefined || input === null) {
    return { providers: [] };
  }
  const root = asRecord(input, "发布设置");
  if (root["providers"] === undefined) {
    return { providers: [] };
  }
  if (!Array.isArray(root["providers"])) {
    fail("发布设置的 providers 必须是数组");
  }

  const seenProviderIds = new Set<string>();
  const providers: PublishedProviderSetting[] = [];
  for (const entry of root["providers"]) {
    const record = asRecord(entry, "发布设置的 providers 条目");
    const providerId = readTrimmed(record["providerId"], "上游 provider id", 100);
    if (seenProviderIds.has(providerId)) {
      fail(`上游 provider 重复：${providerId}`);
    }
    seenProviderIds.add(providerId);

    const protocolRaw = record["clientProtocol"];
    if (!isClientProtocol(protocolRaw)) {
      fail(`上游 ${providerId} 的客户端协议非法，允许：${CLIENT_PROTOCOLS.join(", ")}`);
    }

    if (record["models"] !== undefined && !Array.isArray(record["models"])) {
      fail(`上游 ${providerId} 的 models 必须是数组`);
    }
    const seenDisplayNames = new Set<string>();
    const models: PublishedModelSetting[] = [];
    for (const item of record["models"] ?? []) {
      const model = asRecord(item, `上游 ${providerId} 的模型条目`);
      const upstreamModelId = readTrimmed(
        model["upstreamModelId"],
        `上游 ${providerId} 的模型 ID`,
        200,
      );
      // 显示名缺省取上游模型 ID：管理员不改名时行为可预期。
      const displayName = readTrimmed(
        model["displayName"] ?? upstreamModelId,
        `模型 ${upstreamModelId} 的显示名`,
        200,
      );
      if (seenDisplayNames.has(displayName)) {
        fail(
          `上游 ${providerId} 里有重复的显示名：${displayName}（显示名是客户端请求用的模型 ID，不能重名）`,
        );
      }
      seenDisplayNames.add(displayName);
      models.push({
        upstreamModelId,
        displayName,
        contextWindow: readOptionalPositiveInt(
          model["contextWindow"],
          `模型 ${displayName} 的上下文窗口`,
        ),
        maxOutputTokens: readOptionalPositiveInt(
          model["maxOutputTokens"],
          `模型 ${displayName} 的输出上限`,
        ),
        supportsImage: readOptionalBoolean(model["supportsImage"], "supportsImage"),
        supportsPdf: readOptionalBoolean(model["supportsPdf"], "supportsPdf"),
        supportsVideo: readOptionalBoolean(model["supportsVideo"], "supportsVideo"),
        supportsAudio: readOptionalBoolean(model["supportsAudio"], "supportsAudio"),
        supportsToolCall: readOptionalBoolean(model["supportsToolCall"], "supportsToolCall"),
        reasoningLevels: readReasoningLevels(model["reasoningLevels"]),
      });
    }
    providers.push({ providerId, clientProtocol: protocolRaw, models });
  }
  return { providers };
}
