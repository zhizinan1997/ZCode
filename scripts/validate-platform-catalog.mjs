/**
 * 用客户端自己的解码器校验"模型发布"生成的目录（specs/platform/model-publish.md 验收 1/4）。
 *
 * 平台侧的 catalogService 只做结构校验，无法复刻客户端的严格 schema；
 * 这里以仓库内置目录 config/provider/zcode-builtin.json 为基线、以服务端同一套
 * buildCatalog 生成目录，再交给 decodeZCodeBuiltinRelease 校验——
 * 客户端解不开就是不通过。分别验证保留/不保留内置 provider 两种模式。
 *
 * 用法（仓库根目录）：npx tsx scripts/validate-platform-catalog.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeZCodeBuiltinRelease } from "../packages/provider-node/src/zcode-builtin-release.js";
import { normalizeModelSettings } from "../packages/platform/src/domain/modelPublish.js";
import { buildCatalog } from "../packages/platform/src/domain/modelPublishCatalog.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const builtin = JSON.parse(
  readFileSync(resolve(repoRoot, "config/provider/zcode-builtin.json"), "utf8"),
);

const settings = normalizeModelSettings({
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
        { upstreamModelId: "claude-sonnet-4-5" },
      ],
    },
  ],
});

const providerLabels = new Map([["1", "平台免费上游"]]);
let failures = 0;

for (const keepBuiltinProviders of [true, false]) {
  const mode = keepBuiltinProviders ? "保留内置 provider" : "不保留内置 provider";
  try {
    const built = buildCatalog({
      settings,
      builtinCatalog: builtin,
      origin: "https://rcode.example.com",
      revision: Math.max(builtin.revision + 1, 31),
      keepBuiltinProviders,
      providerLabels,
    });
    const parsed = JSON.parse(built.content);
    const decoded = decodeZCodeBuiltinRelease(parsed);
    const platformProvider = [...decoded.config.providers.keys()].find((id) =>
      String(id).startsWith("platform:"),
    );
    const displayNames = built.content.includes("GLM-5.3 免费版");
    const hasRealKey = built.content.includes("sk-");
    console.log(
      `[${mode}] 通过：revision ${decoded.revision}，provider ${[...decoded.config.providers.keys()].length} 个`,
    );
    console.log(`  平台 provider：${platformProvider ?? "（缺失！）"}；显示名进入目录：${displayNames}`);
    if (!platformProvider) throw new Error("平台 provider 缺失");
    if (!displayNames) throw new Error("显示名未进入目录");
    if (hasRealKey) throw new Error("目录里出现了疑似真实 key（sk-）");
  } catch (error) {
    failures += 1;
    console.error(`[${mode}] 未通过：`, error instanceof Error ? error.message : error);
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log("两种模式均通过客户端解码器校验。");
}
