/**
 * 生成平台可下发的模型目录（`builtin_provider_config_json` 指向的那份 JSON）。
 *
 * 为什么需要它：客户端对目录的 schema 是**严格**的——顶层必须是
 * `{ schemaVersion, revision, config: { providerConfigRules, modelConfigRules } }`，
 * 且 `config` 只允许这两个键。手写极易出错，而平台侧的校验只能做结构检查，
 * 无法完全复刻客户端 schema（平台不能依赖 @zcode/provider-node）。
 * 因此这里用**客户端自己的解码器**校验产物，产出的目录保证能被客户端接受。
 *
 * 用法：
 *   # 1) 把内置目录里指定的 provider 改指向平台网关
 *   tsx scripts/build-platform-catalog.mjs \
 *     --origin https://rcode.example.com \
 *     --rewrite account:zai-individual-coding-plan \
 *     --out build/platform-catalog.json
 *
 *   # 2) 追加平台自有的 provider（JSON 片段，见 --add 文件格式）
 *   tsx scripts/build-platform-catalog.mjs \
 *     --origin https://rcode.example.com \
 *     --add deploy/provider-snippet.json \
 *     --out build/platform-catalog.json
 *
 * --add 文件格式：
 *   {
 *     "providers": [
 *       {
 *         "providerId": "my-upstream",
 *         "providerName": "我的上游",
 *         "apiType": "anthropic-messages",
 *         "models": ["claude-x", "claude-y"]
 *       }
 *     ]
 *   }
 * 生成的 provider 会带上 `access.type = "api-key"` 与占位 key：真正的上游 key
 * 由平台网关持有并注入，客户端配置里的 key 只是占位（客户端会把它发给网关，
 * 网关替换掉，不会到达上游）。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeZCodeBuiltinRelease } from "../packages/provider-node/src/zcode-builtin-release.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const origin = readArg("origin")?.replace(/\/$/, "");
if (!origin) {
  console.error("必须提供 --origin（例如 https://rcode.example.com）");
  process.exit(1);
}
const sourcePath = readArg("source", resolve(repoRoot, "config/provider/zcode-builtin.json"));
const outPath = readArg("out", resolve(repoRoot, "build/platform-catalog.json"));
const addPath = readArg("add");
const rewriteIds = (readArg("rewrite") ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const source = JSON.parse(readFileSync(sourcePath, "utf8"));
const catalog = structuredClone(source);

/** 指向平台网关：客户端把请求发到这里，网关再转发到真实上游并注入平台 key。 */
function gatewayBaseUrl(providerId) {
  return `${origin}/api/v1/gateway/${providerId}`;
}

let rewritten = 0;
for (const rule of catalog.config.providerConfigRules.providerRules ?? []) {
  if (!rewriteIds.includes(rule.providerId)) {
    continue;
  }
  if (!rule.config?.api) {
    throw new Error(`provider ${rule.providerId} 缺少 config.api，无法改指向`);
  }
  rule.config.api.baseUrl = gatewayBaseUrl(rule.providerId);
  rewritten += 1;
}

const addedProviders = [];
if (addPath) {
  const snippet = JSON.parse(readFileSync(addPath, "utf8"));
  const rules = catalog.config.providerConfigRules.providerRules ?? [];
  const modelBindings = catalog.config.modelConfigRules.builtinProviderModelRules ?? [];
  for (const provider of snippet.providers ?? []) {
    const providerId = String(provider.providerId);
    rules.push({
      providerId,
      providerName: provider.providerName ?? providerId,
      config: {
        // 必须是两个厂商族之一：内置 provider 的 schema 明确排除了 standard-personal
        // （见 packages/provider/src/config/rule-data-schema.ts 的 group 定义），
        // 因为客户端按族决定模型在界面上的可见性。平台自有上游因此也得挂到某个族下。
        group: provider.group ?? "zai-family",
        // 内置 provider 的模型列表就声明在这里：只写 builtinProviderModelRules
        // 不会让模型出现在界面上（那是规则层，不是可见清单）。
        builtinModelIds: provider.models ?? [],
        // 占位 key：客户端会把它发给平台网关，网关换成真正的上游 key。
        access: { type: "api-key", apiKey: "platform-gateway-managed" },
        api: { type: provider.apiType ?? "anthropic-messages", baseUrl: gatewayBaseUrl(providerId) },
      },
    });
    for (const modelId of provider.models ?? []) {
      modelBindings.push({ providerId, modelId, config: { enabled: true } });
    }
    addedProviders.push(providerId);
  }
  catalog.config.providerConfigRules.providerRules = rules;
  catalog.config.modelConfigRules.builtinProviderModelRules = modelBindings;
}

// revision 必须严格递增，客户端才会应用；没有显式指定时在源目录基础上 +1。
const explicitRevision = readArg("revision");
catalog.revision = explicitRevision ? Number(explicitRevision) : Number(source.revision ?? 0) + 1;

// 用客户端自己的解码器校验：不通过就直接失败，避免把客户端无法解析的目录推给全部客户端。
const decoded = decodeZCodeBuiltinRelease(catalog);
if (explicitRevision && decoded.revision !== Number(explicitRevision)) {
  throw new Error("解码后的 revision 与预期不一致");
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      source: sourcePath.replace(repoRoot, "."),
      out: outPath.replace(repoRoot, "."),
      origin,
      revision: { from: source.revision, to: catalog.revision },
      rewrittenProviders: rewriteIds.filter((id) =>
        (source.config.providerConfigRules.providerRules ?? []).some((r) => r.providerId === id),
      ).length,
      addedProviders,
      validated: true,
      providerCount: decoded.config.providers.size,
    },
    null,
    2,
  ),
);
