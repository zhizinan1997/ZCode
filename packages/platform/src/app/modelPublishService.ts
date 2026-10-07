/**
 * 模型发布用例（specs/platform/model-publish.md）。
 *
 * 职责边界：
 * - 发布设置（选了哪些模型、显示名、能力、顺序、客户端协议）的唯一事实源是
 *   ModelPublishRepository（published_providers / published_models 表）；
 * - 已下发目录的唯一事实源仍是 catalogService（model_catalog 表）——apply 只是通过它
 *   校验并写入，绝不另写一条目录通道；
 * - fetch-models 在 adminCatalog 路由层（一次性探测，不落库），本服务不感知上游网络。
 *
 * apply 的事件顺序（与 spec 一致）：读设置 → normalize → 算 revision（≥ 库内当前与
 * 内置目录的较大者 +1，且 > 30）→ buildCatalog 纯函数生成 → catalog.update
 * （结构校验 + revision 递增 + expectedRevision 乐观并发）→ 返回新 revision。
 * 任一步失败都不会产生写入。
 */
import type { CatalogService } from "./catalogService.js";
import { PlatformError } from "../domain/errors.js";
import { normalizeModelSettings, type ModelPublishSettings } from "../domain/modelPublish.js";
import {
  buildCatalog,
  nextRevision,
  type BuiltCatalogSummary,
} from "../domain/modelPublishCatalog.js";
import type { GatewayProviderRepository, ModelPublishRepository } from "./ports.js";

export interface PublishPreview {
  readonly revision: number;
  readonly summary: BuiltCatalogSummary;
  readonly content: string;
}

export interface ModelPublishService {
  /** 当前发布设置；从未保存过时返回空设置。 */
  readSettings(): Promise<ModelPublishSettings>;
  /** 全量保存发布设置（服务端 normalize 是唯一校验者）。返回规范化后的设置。 */
  saveSettings(input: {
    settings: unknown;
    updatedBy: string | null;
  }): Promise<ModelPublishSettings>;
  /** 生成目录但不写库：发布页预览摘要与 JSON。 */
  preview(input: { keepBuiltinProviders: boolean }): Promise<PublishPreview>;
  /** 生成并写入新 revision；返回写入后的 revision。 */
  apply(input: {
    keepBuiltinProviders: boolean;
    updatedBy: string | null;
  }): Promise<{ revision: number }>;
}

export function createModelPublishService(deps: {
  readonly publish: ModelPublishRepository;
  readonly providers: GatewayProviderRepository;
  readonly catalog: CatalogService;
  /** 站点根地址（https）；目录里的网关 baseUrl 由它拼出。 */
  readonly getPublicOrigin: () => string | null;
  readonly now: () => number;
}): ModelPublishService {
  async function loadSettings(): Promise<ModelPublishSettings> {
    const stored = await deps.publish.readSettings();
    // 从库里读出来再 normalize 一次：防御手改数据库产生的脏数据，也让保存与
    // apply 走同一条校验路径，不出现"存进去的和推出去的规则不一致"。
    return normalizeModelSettings(stored ?? { providers: [] });
  }

  async function buildFromCurrentState(input: {
    keepBuiltinProviders: boolean;
  }): Promise<{ content: string; summary: BuiltCatalogSummary; currentRevision: number | null }> {
    const settings = await loadSettings();
    if (settings.providers.length === 0) {
      throw new PlatformError(
        "invalid_request",
        "还没有保存任何要发布的模型：请先在发布页勾选模型并点“保存”，再预览或推送",
      );
    }
    const origin = deps.getPublicOrigin();
    if (!origin) {
      throw new PlatformError(
        "invalid_request",
        "未配置站点地址（ZCODE_PLATFORM_PUBLIC_ORIGIN），无法生成客户端目录地址",
      );
    }
    const builtin = await deps.catalog.readBuiltin();
    if (!builtin) {
      throw new PlatformError(
        "internal_error",
        "内置目录文件缺失（config/provider/zcode-builtin.json）：部署必须携带它，发布以此为基础",
      );
    }
    const [current, providerRecords] = await Promise.all([
      deps.catalog.readCurrent(),
      deps.providers.list(),
    ]);
    // 客户端在"随包内置"与"远程"之间取较大 revision，所以下限必须同时考虑两者。
    const floor = Math.max(current?.revision ?? 0, builtin.revision);
    const revision = nextRevision(floor);
    let builtinJson: unknown;
    try {
      builtinJson = JSON.parse(builtin.content);
    } catch (error) {
      throw new PlatformError("internal_error", "内置目录文件不是合法 JSON", { cause: error });
    }
    const labels = new Map(providerRecords.map((provider) => [provider.id, provider.label]));
    const built = buildCatalog({
      settings,
      builtinCatalog: builtinJson,
      origin,
      revision,
      keepBuiltinProviders: input.keepBuiltinProviders,
      providerLabels: labels,
    });
    return {
      content: built.content,
      summary: built.summary,
      currentRevision: current?.revision ?? null,
    };
  }

  return {
    async readSettings() {
      return await loadSettings();
    },

    async saveSettings(input) {
      const settings = normalizeModelSettings(input.settings);
      await deps.publish.writeSettings(settings, { updatedBy: input.updatedBy, now: deps.now() });
      return settings;
    },

    async preview(input) {
      const built = await buildFromCurrentState(input);
      return { revision: built.summary.revision, summary: built.summary, content: built.content };
    },

    async apply(input) {
      const built = await buildFromCurrentState(input);
      // expectedRevision 用 apply 开始时读到的当前值：两个管理员并发推送时，
      // 后提交者在这里拿到 conflict 而不是静默覆盖（catalogService 的乐观并发）。
      const written = await deps.catalog.update({
        content: built.content,
        expectedRevision: built.currentRevision,
        updatedBy: input.updatedBy,
      });
      return { revision: written };
    },
  };
}
