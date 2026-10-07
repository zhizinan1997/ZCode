/**
 * 内置模型目录（config/provider/zcode-builtin.json）的读取与摘要。
 *
 * 从 catalogService 拆出的原因：max-lines 架构约束；它只依赖目录 JSON 的形状，
 * 与"当前生效目录"的读写是两个关注点：
 * - revision 下限（审计#20）与发布页预填（审计#22+#26）都以内置目录为事实源；
 * - 文件缺失时返回 null，由调用方决定降级语义（不阻塞启动）。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PlatformError } from "../domain/errors.js";

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformError("invalid_request", `${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

/**
 * 内置目录中实际使用的思考等级词表：`config/provider/zcode-builtin.json` v30 里全部
 * `reasoningLevel.values` 的并集。anthropic 的 thinking 与 openai 的 reasoning_effort
 * 在客户端 option map 里映射时用的就是这些取值（审计#22+#26），发布页只允许从中选择。
 */
export const KNOWN_THINKING_LEVELS = [
  "disabled",
  "enabled",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** 内置 provider 的 `group` 只允许两个厂商族之一（客户端 schema 明确排除 standard-personal）。 */
export const BUILTIN_PROVIDER_GROUPS = ["zai-family", "bigmodel-family"] as const;

export interface BuiltinCatalogFile {
  readonly revision: number;
  readonly content: string;
}

const DEFAULT_BUILTIN_CATALOG_CANDIDATES: readonly URL[] = [
  // 容器镜像布局：dist/app → /app/builtin（deploy/Dockerfile.platform 拷贝到这里，审计#23）。
  new URL("../../builtin/zcode-builtin.json", import.meta.url),
  // 仓库源码运行：src/app → 仓库根的 config/provider。
  new URL("../../../../config/provider/zcode-builtin.json", import.meta.url),
];

/**
 * 读取随包内置目录：按候选路径依次尝试，第一个存在且合法的胜出；全部缺失返回 null。
 *
 * 返回 null 不阻塞启动：revision 下限退化为库内当前值、发布页没有预填，
 * 但正式部署必须携带该文件（specs/platform/model-catalog.md"部署"）。
 */
export async function readBuiltinCatalogFile(
  candidates: readonly URL[] = [
    ...DEFAULT_BUILTIN_CATALOG_CANDIDATES,
    // 开发时从仓库根或其他 cwd 启动的兜底。
    pathToFileURL(resolve(process.cwd(), "config/provider/zcode-builtin.json")),
  ],
): Promise<BuiltinCatalogFile | null> {
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await readFile(candidate, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const root = asRecord(parsed, "内置目录");
      const revision = root["revision"];
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
        continue;
      }
      return { revision, content: raw };
    } catch {
      continue;
    }
  }
  return null;
}

export interface BuiltinCatalogProviderSummary {
  readonly providerId: string;
  readonly providerName: string;
  readonly group: string | null;
  readonly modelIds: readonly string[];
}

export interface BuiltinCatalogModelCapabilities {
  readonly modelId: string;
  readonly contextWindow: number | null;
  readonly thinkingLevels: readonly string[] | null;
}

export interface BuiltinCatalogSummary {
  readonly revision: number;
  readonly providers: readonly BuiltinCatalogProviderSummary[];
  readonly capabilities: readonly BuiltinCatalogModelCapabilities[];
}

export interface ParsedCatalogShape {
  config: {
    providerConfigRules: { templateRules?: unknown[]; providerRules?: unknown[] };
    modelConfigRules: {
      modelRules?: unknown[];
      builtinProviderModelRules?: unknown[];
      templateModelRules?: unknown[];
      modelApiRules?: unknown[];
      providerSiteRules?: unknown[];
    };
  };
}

/** 宽松解析内置/目录 JSON 的共同形状；非法结构抛错由调用方决定语义。 */
export function parseCatalogShape(content: string): ParsedCatalogShape {
  const root = asRecord(JSON.parse(content), "目录");
  const config = asRecord(root["config"], "目录的 config");
  const providerConfigRules = asRecord(config["providerConfigRules"], "providerConfigRules");
  const modelConfigRules = asRecord(config["modelConfigRules"], "modelConfigRules");
  return {
    config: {
      providerConfigRules:
        providerConfigRules as ParsedCatalogShape["config"]["providerConfigRules"],
      modelConfigRules: modelConfigRules as ParsedCatalogShape["config"]["modelConfigRules"],
    },
  };
}

function readBuiltinModelIds(rule: Record<string, unknown>): string[] {
  const config = asRecord(rule["config"] ?? {}, "provider config");
  const ids = config["builtinModelIds"];
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

/**
 * 从目录的 `modelRules`（按 `modelMatch` 正则顺序 overlay）推出每个模型的默认能力，
 * 用作发布页 `contextWindow` 与思考等级的预填值（审计#22+#26）。
 * 客户端 resolver 同样按序 overlay：后命中的规则覆盖先命中的字段。
 */
export function builtinModelCapabilities(
  content: string,
  modelIds: readonly string[],
): BuiltinCatalogModelCapabilities[] {
  let modelRules: unknown[];
  try {
    modelRules = parseCatalogShape(content).config.modelConfigRules.modelRules ?? [];
  } catch {
    return [];
  }
  const rules = modelRules.flatMap((entry) => {
    const record = entry as Record<string, unknown>;
    const match = typeof record["modelMatch"] === "string" ? record["modelMatch"] : null;
    if (match === null) return [];
    const config = (record["config"] ?? {}) as Record<string, unknown>;
    const properties = (config["properties"] ?? null) as Record<string, unknown> | null;
    const optionSpecs = (config["optionSpecs"] ?? null) as Record<string, unknown> | null;
    const reasoningLevel = (optionSpecs?.["reasoningLevel"] ?? null) as Record<
      string,
      unknown
    > | null;
    const values = reasoningLevel?.["values"];
    try {
      return [
        {
          // 客户端 resolver 匹配 modelMatch 时忽略大小写（packages/provider model-config.ts
          // 的 matchesRule(…, ignoreCase = true)），预填必须保持同一语义。
          matcher: new RegExp(match, "i"),
          contextWindow:
            properties && typeof properties["contextWindow"] === "number"
              ? (properties["contextWindow"] as number)
              : null,
          thinkingLevels: Array.isArray(values)
            ? (values.filter((v): v is string => typeof v === "string") as string[])
            : null,
        },
      ];
    } catch {
      // 内置目录的正则都合法；防御个别非法值，跳过该条规则即可。
      return [];
    }
  });

  return modelIds.map((modelId) => {
    let contextWindow: number | null = null;
    let thinkingLevels: string[] | null = null;
    for (const rule of rules) {
      if (!rule.matcher.test(modelId)) continue;
      if (rule.contextWindow !== null) contextWindow = rule.contextWindow;
      if (rule.thinkingLevels !== null) thinkingLevels = rule.thinkingLevels;
    }
    return { modelId, contextWindow, thinkingLevels };
  });
}

/** 内置目录摘要：发布页用它展示 provider/模型清单并预填能力。 */
export function summarizeBuiltinCatalog(content: string): BuiltinCatalogSummary {
  const root = asRecord(JSON.parse(content), "内置目录");
  const revision = root["revision"];
  if (typeof revision !== "number") {
    throw new PlatformError("invalid_request", "内置目录缺少 revision");
  }
  const parsed = parseCatalogShape(content);
  const providerRules = (parsed.config.providerConfigRules.providerRules ?? []) as Record<
    string,
    unknown
  >[];
  const templateRules = (parsed.config.providerConfigRules.templateRules ?? []) as Record<
    string,
    unknown
  >[];
  const providers: BuiltinCatalogProviderSummary[] = [];
  const modelIdSet = new Set<string>();
  for (const rule of providerRules) {
    if (typeof rule["providerId"] !== "string") continue;
    const modelIds = readBuiltinModelIds(rule);
    const config = (rule["config"] ?? {}) as Record<string, unknown>;
    providers.push({
      providerId: rule["providerId"],
      providerName:
        typeof rule["providerName"] === "string" ? rule["providerName"] : rule["providerId"],
      group: typeof config["group"] === "string" ? (config["group"] as string) : null,
      modelIds,
    });
    for (const id of modelIds) modelIdSet.add(id);
  }
  for (const rule of templateRules) {
    for (const id of readBuiltinModelIds(rule)) modelIdSet.add(id);
  }
  return {
    revision,
    providers,
    capabilities: builtinModelCapabilities(content, [...modelIdSet]),
  };
}
