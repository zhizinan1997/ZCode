/**
 * 模型发布设置的端口（specs/platform/model-publish.md）。
 *
 * 从 ports.ts 拆出是架构 max-lines 约束；仓储实现见 adapters/sqlite/publishRepo.ts，
 * 用例见 modelPublishService.ts，网关用 findUpstreamModelId 把显示名改写回真实 ID。
 */
import type { ModelPublishSettings } from "../domain/modelPublish.js";

export interface ModelPublishRepository {
  /** 当前发布设置；从未保存过时返回 null。 */
  readSettings(): Promise<ModelPublishSettings | null>;
  /** 全量替换发布设置（设置量小，管理员页面每次提交完整草稿）。 */
  writeSettings(
    settings: ModelPublishSettings,
    meta: { updatedBy: string | null; now: number },
  ): Promise<void>;
  /** 网关改写用：(providerId, 客户端 modelId=显示名) → 上游真实模型 ID。 */
  findUpstreamModelId(providerId: string, clientModelId: string): Promise<string | null>;
}
