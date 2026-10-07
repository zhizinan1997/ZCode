/** 网关上游 provider 与模型单价的 SQLite 实现。 */
import type { DatabaseSync } from "node:sqlite";
import type { GatewayProtocol, GatewayProvider } from "../../domain/gateway.js";
import { isGatewayProtocol } from "../../domain/gateway.js";
import type {
  GatewayProviderRepository,
  ModelPriceRecord,
  ModelPriceRepository,
} from "../../app/ports.js";

interface ProviderRow {
  id: string;
  label: string;
  upstream_base_url: string;
  api_key: string;
  protocol: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface PriceRow {
  model_id: string;
  input_micros_per_million: number;
  output_micros_per_million: number;
  cache_read_micros_per_million: number;
  cache_write_micros_per_million: number;
  updated_at: number;
}

function toProvider(row: ProviderRow): GatewayProvider {
  if (!isGatewayProtocol(row.protocol)) {
    throw new Error(`未知上游协议：${row.protocol}`);
  }
  const protocol: GatewayProtocol = row.protocol;
  return {
    id: row.id,
    label: row.label,
    upstreamBaseUrl: row.upstream_base_url,
    apiKey: row.api_key,
    protocol,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSqliteGatewayProviderRepository(db: DatabaseSync): GatewayProviderRepository {
  return {
    async list() {
      const rows = db
        .prepare("SELECT * FROM gateway_providers ORDER BY id ASC")
        .all() as unknown as ProviderRow[];
      return rows.map(toProvider);
    },

    async findById(id) {
      const row = db.prepare("SELECT * FROM gateway_providers WHERE id = ?").get(id) as unknown as
        | ProviderRow
        | undefined;
      return row ? toProvider(row) : null;
    },

    async upsert(provider) {
      db.prepare(
        `INSERT INTO gateway_providers
           (id, label, upstream_base_url, api_key, protocol, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           upstream_base_url = excluded.upstream_base_url,
           api_key = excluded.api_key,
           protocol = excluded.protocol,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      ).run(
        provider.id,
        provider.label,
        provider.upstreamBaseUrl,
        provider.apiKey,
        provider.protocol,
        provider.enabled ? 1 : 0,
        provider.createdAt,
        provider.updatedAt,
      );
    },

    async remove(id) {
      db.prepare("DELETE FROM gateway_providers WHERE id = ?").run(id);
    },
  };
}

export function createSqliteModelPriceRepository(db: DatabaseSync): ModelPriceRepository {
  const toRecord = (row: PriceRow): ModelPriceRecord => ({
    modelId: row.model_id,
    inputMicrosPerMillion: row.input_micros_per_million,
    outputMicrosPerMillion: row.output_micros_per_million,
    cacheReadMicrosPerMillion: row.cache_read_micros_per_million,
    cacheWriteMicrosPerMillion: row.cache_write_micros_per_million,
    updatedAt: row.updated_at,
  });

  return {
    async list() {
      const rows = db
        .prepare("SELECT * FROM model_prices ORDER BY model_id ASC")
        .all() as unknown as PriceRow[];
      return rows.map(toRecord);
    },

    async findByModelId(modelId) {
      const row = db
        .prepare("SELECT * FROM model_prices WHERE model_id = ?")
        .get(modelId) as unknown as PriceRow | undefined;
      return row ? toRecord(row) : null;
    },

    async upsert(record) {
      db.prepare(
        `INSERT INTO model_prices
           (model_id, input_micros_per_million, output_micros_per_million,
            cache_read_micros_per_million, cache_write_micros_per_million, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(model_id) DO UPDATE SET
           input_micros_per_million = excluded.input_micros_per_million,
           output_micros_per_million = excluded.output_micros_per_million,
           cache_read_micros_per_million = excluded.cache_read_micros_per_million,
           cache_write_micros_per_million = excluded.cache_write_micros_per_million,
           updated_at = excluded.updated_at`,
      ).run(
        record.modelId,
        record.inputMicrosPerMillion,
        record.outputMicrosPerMillion,
        record.cacheReadMicrosPerMillion,
        record.cacheWriteMicrosPerMillion,
        record.updatedAt,
      );
    },

    async remove(modelId) {
      db.prepare("DELETE FROM model_prices WHERE model_id = ?").run(modelId);
    },
  };
}
