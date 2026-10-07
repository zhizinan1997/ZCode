/**
 * 模型目录生成（纯函数）：把发布设置与内置目录基线合成为客户端严格 schema 的目录。
 *
 * 与 modelPublish.ts（设置与校验）拆分是架构 max-lines 约束；
 * 规则口径见 specs/platform/model-publish.md：显示名即客户端 modelId、
 * 绝不生成 map、keepBuiltinProviders 的替换语义都在这里。
 */
import { PlatformError } from "./errors.js";
import {
  BUILTIN_CATALOG_REVISION,
  PLATFORM_ACCESS_PLACEHOLDER,
  PLATFORM_PROVIDER_ID_PREFIX,
  asRecord,
  fail,
  type ModelPublishSettings,
  type PublishedModelSetting,
} from "./modelPublish.js";

/**
 * 下一次推送应使用的 revision。
 *
 * 客户端只在 revision 严格变大时才应用目录，且随包内置目录是 30，所以下限是 31；
 * 已有平台目录时在其基础上 +1。
 */
export function nextRevision(current: number | null): number {
  return Math.max((current ?? 0) + 1, BUILTIN_CATALOG_REVISION + 1);
}

export interface BuiltCatalogSummary {
  readonly revision: number;
  readonly providerCount: number;
  readonly modelCount: number;
}

export interface BuildCatalogInput {
  readonly settings: ModelPublishSettings;
  /** 内置目录基线（已解析的 JSON）：config/provider/zcode-builtin.json。 */
  readonly builtinCatalog: unknown;
  /** 站点根地址（https）。目录里的 baseUrl 都由它拼出。 */
  readonly origin: string;
  readonly revision: number;
  /** false 时不保留内置 provider（客户端目录里只剩平台自有上游）。 */
  readonly keepBuiltinProviders: boolean;
  /** gateway provider id → 展示名（目录里 providerName 用）。 */
  readonly providerLabels: ReadonlyMap<string, string>;
}

export interface BuiltCatalog {
  readonly content: string;
  readonly summary: BuiltCatalogSummary;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(
      `内置目录的 ${label} 必须是数组（基线文件可能被改动，请检查 config/provider/zcode-builtin.json）`,
    );
  }
  return value;
}

/**
 * 生成目录内容（纯函数）。
 *
 * - 在内置目录基线上追加平台自有 provider；`keepBuiltinProviders=false` 时替换
 *   providerRules / builtinProviderModelRules / templateRules / templateModelRules，
 *   但保留 modelRules / modelApiRules / providerSiteRules——思考参数的兜底映射
 *   （modelMatch ".*" 的 modelApiRules）来自它们，删掉会让所有模型失去思考档位。
 * - 只写 values / max / properties，绝不生成 `map`（映射以内置 modelApiRules 为唯一事实源）。
 * - 与内置 provider 重名（platform:<id> 已存在）直接报错，而不是静默覆盖。
 */
export function buildCatalog(input: BuildCatalogInput): BuiltCatalog {
  const { settings, builtinCatalog, origin, revision, keepBuiltinProviders, providerLabels } =
    input;
  if (!origin.startsWith("https://")) {
    // 客户端的目录下载地址必须是 https 且不带凭据（zcode-builtin-download.ts 的 refine）。
    fail(`站点地址必须是 https，当前：${origin}`);
  }
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    fail(`目录 revision 必须是正整数，收到 ${String(revision)}`);
  }

  const base = asRecord(builtinCatalog, "内置目录");
  if (base["schemaVersion"] !== 1) {
    fail("内置目录的 schemaVersion 必须为 1");
  }
  const baseConfig = asRecord(base["config"], "内置目录的 config");
  const baseProviderConfigRules = asRecord(
    baseConfig["providerConfigRules"],
    "内置目录的 config.providerConfigRules",
  );
  const baseModelConfigRules = asRecord(
    baseConfig["modelConfigRules"],
    "内置目录的 config.modelConfigRules",
  );
  // structuredClone 隔离基线：buildCatalog 绝不改写传入对象，重试/预览才不会互相污染。
  const catalog = structuredClone(base);
  const config = catalog["config"] as Record<string, unknown>;
  const providerConfigRules = config["providerConfigRules"] as Record<string, unknown>;
  const modelConfigRules = config["modelConfigRules"] as Record<string, unknown>;
  const baseProviderRules = requireArray(baseProviderConfigRules["providerRules"], "providerRules");
  const baseBuiltinProviderModelRules = requireArray(
    baseModelConfigRules["builtinProviderModelRules"],
    "builtinProviderModelRules",
  );

  if (settings.providers.length === 0) {
    fail("还没有选择任何要发布的模型（推空目录会让所有客户端失去模型列表）");
  }
  const baseProviderIds = new Set(
    baseProviderRules.map((rule) =>
      typeof rule === "object" && rule !== null && "providerId" in rule
        ? String((rule as Record<string, unknown>)["providerId"])
        : "",
    ),
  );

  const providerRules: unknown[] = keepBuiltinProviders ? [...baseProviderRules] : [];
  const modelBindings: unknown[] = keepBuiltinProviders ? [...baseBuiltinProviderModelRules] : [];
  let modelCount = 0;

  for (const provider of settings.providers) {
    if (provider.models.length === 0) {
      fail(`上游 ${provider.providerId} 没有选择任何模型；请取消勾选该上游或至少选择一个模型`);
    }
    const platformProviderId = `${PLATFORM_PROVIDER_ID_PREFIX}${provider.providerId}`;
    // keep=false 时基线 providerRules 会被整体替换，重名无关紧要；只有追加模式才会合成同一身份。
    if (keepBuiltinProviders && baseProviderIds.has(platformProviderId)) {
      fail(
        `目录基线里已存在 provider ${platformProviderId}（可能被手动改过目录）。` +
          "请先在「模型目录」页移除它，或关闭“保留内置 provider”后再推送。",
      );
    }
    providerRules.push({
      providerId: platformProviderId,
      providerName: providerLabels.get(provider.providerId) ?? provider.providerId,
      config: {
        // 内置 provider 的 group 明确排除 standard-personal（客户端按族决定可见性），
        // 平台自有上游统一挂 zai-family。
        group: "zai-family",
        // 模型列表必须写在这里：只写 builtinProviderModelRules 不会让模型出现在界面上。
        builtinModelIds: provider.models.map((model) => model.displayName),
        // 占位 key：客户端会把它发给网关，网关换成真正的上游 key（key 绝不进目录）。
        access: { type: "api-key", apiKey: PLATFORM_ACCESS_PLACEHOLDER },
        api: {
          type: provider.clientProtocol,
          baseUrl: `${origin}/api/v1/gateway/${provider.providerId}`,
        },
      },
    });

    for (const model of provider.models) {
      const properties: Record<string, unknown> = {
        supportsToolCall: model.supportsToolCall,
      };
      if (model.contextWindow !== null) {
        properties["contextWindow"] = model.contextWindow;
      }
      properties["inputFormat"] = {
        supportsImage: model.supportsImage,
        supportsPdf: model.supportsPdf,
        supportsVideo: model.supportsVideo,
        supportsAudio: model.supportsAudio,
      };
      const optionSpecs: Record<string, unknown> = {};
      if (model.reasoningLevels !== null) {
        optionSpecs["reasoningLevel"] = { values: model.reasoningLevels };
      }
      if (model.maxOutputTokens !== null) {
        optionSpecs["maxOutputTokens"] = { max: model.maxOutputTokens };
      }
      // 刻意不写 reasoningLevel/maxOutputTokens 的 map：映射以内置 modelApiRules 的
      // 兜底规则为唯一事实源，两处各写一份必然漂移。
      modelBindings.push({
        providerId: platformProviderId,
        modelId: model.displayName,
        config: {
          enabled: true,
          properties,
          ...(Object.keys(optionSpecs).length > 0 ? { optionSpecs } : {}),
        },
      });
      modelCount += 1;
    }
  }

  providerConfigRules["providerRules"] = providerRules;
  modelConfigRules["builtinProviderModelRules"] = modelBindings;
  if (!keepBuiltinProviders) {
    // 模板与模板模型规则都只服务于内置 account:* provider；它们退场后一并清空，
    // 避免客户端目录里留下引用不存在模板的孤儿规则。
    providerConfigRules["templateRules"] = [];
    modelConfigRules["templateModelRules"] = [];
  }
  catalog["revision"] = revision;

  return {
    content: `${JSON.stringify(catalog, null, 2)}\n`,
    summary: {
      revision,
      providerCount: providerRules.length,
      modelCount,
    },
  };
}
