/** 模型发布设置的 SQLite 实现（specs/platform/model-publish.md 的数据模型）。 */
import type { DatabaseSync } from "node:sqlite";
import type { ModelPublishRepository } from "../../app/ports.js";
import type {
  ClientProtocol,
  ModelPublishSettings,
  PublishedModelSetting,
  PublishedProviderSetting,
} from "../../domain/modelPublish.js";
import { isClientProtocol } from "../../domain/modelPublish.js";

interface ProviderRow {
  provider_id: string;
  client_protocol: string;
}

interface ModelRow {
  provider_id: string;
  upstream_model_id: string;
  display_name: string;
  position: number;
  context_window: number | null;
  max_output_tokens: number | null;
  supports_image: number;
  supports_pdf: number;
  supports_video: number;
  supports_audio: number;
  supports_tool_call: number;
  reasoning_levels_json: string | null;
}

function toBool(value: number): boolean {
  return value === 1;
}

function toModel(row: ModelRow): PublishedModelSetting {
  let reasoningLevels: string[] | null = null;
  if (row.reasoning_levels_json) {
    try {
      const parsed: unknown = JSON.parse(row.reasoning_levels_json);
      if (Array.isArray(parsed)) {
        reasoningLevels = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      // 数据损坏时按"未配置"处理，让客户端走内置兜底，而不是让整份设置读不出来。
      reasoningLevels = null;
    }
  }
  return {
    upstreamModelId: row.upstream_model_id,
    displayName: row.display_name,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    supportsImage: toBool(row.supports_image),
    supportsPdf: toBool(row.supports_pdf),
    supportsVideo: toBool(row.supports_video),
    supportsAudio: toBool(row.supports_audio),
    supportsToolCall: toBool(row.supports_tool_call),
    reasoningLevels,
  };
}

/**
 * 发布设置仓储。
 *
 * 设置量很小（几十行），写入采用"事务内全量替换"：管理员页面每次保存的是完整草稿，
 * 没有部分更新的语义，增量 diff 只会引入不必要的复杂度。
 */
export function createSqliteModelPublishRepository(db: DatabaseSync): ModelPublishRepository {
  return {
    async readSettings() {
      const providerRows = db
        .prepare(
          "SELECT provider_id, client_protocol FROM published_providers ORDER BY provider_id",
        )
        .all() as unknown as ProviderRow[];
      if (providerRows.length === 0) {
        return null;
      }
      const modelRows = db
        .prepare(
          `SELECT * FROM published_models
           ORDER BY provider_id, position, upstream_model_id`,
        )
        .all() as unknown as ModelRow[];
      const byProvider = new Map<string, PublishedModelSetting[]>();
      for (const row of modelRows) {
        const list = byProvider.get(row.provider_id) ?? [];
        list.push(toModel(row));
        byProvider.set(row.provider_id, list);
      }
      const providers: PublishedProviderSetting[] = [];
      for (const row of providerRows) {
        if (!isClientProtocol(row.client_protocol)) {
          // 协议枚举扩展过又回滚时可能出现脏值；跳过而不是让整个设置读不出来。
          continue;
        }
        providers.push({
          providerId: row.provider_id,
          clientProtocol: row.client_protocol,
          models: byProvider.get(row.provider_id) ?? [],
        });
      }
      return { providers };
    },

    async writeSettings(settings, meta) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM published_models").run();
        db.prepare("DELETE FROM published_providers").run();
        const insertProvider = db.prepare(
          `INSERT INTO published_providers (provider_id, client_protocol, updated_at, updated_by)
           VALUES (?, ?, ?, ?)`,
        );
        const insertModel = db.prepare(
          `INSERT INTO published_models (
             provider_id, upstream_model_id, display_name, position,
             context_window, max_output_tokens,
             supports_image, supports_pdf, supports_video, supports_audio, supports_tool_call,
             reasoning_levels_json, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const provider of settings.providers) {
          insertProvider.run(
            provider.providerId,
            provider.clientProtocol,
            meta.now,
            meta.updatedBy,
          );
          provider.models.forEach((model, index) => {
            insertModel.run(
              provider.providerId,
              model.upstreamModelId,
              model.displayName,
              index,
              model.contextWindow,
              model.maxOutputTokens,
              model.supportsImage ? 1 : 0,
              model.supportsPdf ? 1 : 0,
              model.supportsVideo ? 1 : 0,
              model.supportsAudio ? 1 : 0,
              model.supportsToolCall ? 1 : 0,
              model.reasoningLevels === null ? null : JSON.stringify(model.reasoningLevels),
              meta.now,
            );
          });
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async findUpstreamModelId(providerId, clientModelId) {
      const row = db
        .prepare(
          "SELECT upstream_model_id FROM published_models WHERE provider_id = ? AND display_name = ?",
        )
        .get(providerId, clientModelId) as unknown as { upstream_model_id: string } | undefined;
      return row ? row.upstream_model_id : null;
    },
  };
}

/** 领域类型透出，供路由层引用（保持与仓储同文件的导出面）。 */
export type { ClientProtocol, ModelPublishSettings };
