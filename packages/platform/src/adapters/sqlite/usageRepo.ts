/**
 * 用量的 SQLite 实现。
 *
 * 与余额/流水分开是因为两者关注点不同：这里负责"预扣 → 结算"的记录状态机，
 * 而 billingRepo 负责余额的原子增减。预扣用 status='reserved' 的行表达，
 * 因此这里的 settle 用 `WHERE status='reserved'` 做条件更新，天然幂等。
 */
import type { DatabaseSync } from "node:sqlite";
import type { UsageRecord, UsageStatus } from "../../domain/billing.js";
import type {
  UsageAppend,
  UsageRepository,
  UsageSettlement,
  UsageTotals,
} from "../../app/ports.js";

interface UsageRow {
  request_id: string;
  user_id: string;
  provider_id: string;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_micros: number;
  status: string;
  http_status: number | null;
  duration_ms: number | null;
  error_message: string | null;
  created_at: number;
  settled_at: number | null;
}

const USAGE_STATUSES: readonly string[] = ["reserved", "ok", "upstream_error", "rejected"];

function toUsageRecord(row: UsageRow): UsageRecord {
  if (!USAGE_STATUSES.includes(row.status)) {
    throw new Error(`未知用量状态：${row.status}`);
  }
  return {
    requestId: row.request_id,
    userId: row.user_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
    },
    costMicros: row.cost_micros,
    status: row.status as UsageStatus,
    httpStatus: row.http_status,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function readTotalsRow(row: {
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_micros: number;
  error_count: number;
}): UsageTotals {
  return {
    requestCount: row.request_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    costMicros: row.cost_micros,
    errorCount: row.error_count,
  };
}

/** 只统计已结算的记录：reserved 还在进行中，rejected 没有产生费用。 */
const SETTLED_PREDICATE = "status IN ('ok', 'upstream_error')";

/**
 * 判断是否为唯一约束冲突。
 *
 * node:sqlite 抛出的是普通 Error，带 errcode。主键冲突与唯一索引冲突的 errcode 不同，
 * 因此同时看错误码与消息，避免因驱动版本差异漏判。
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const errcode = (error as { errcode?: number }).errcode;
  // 1555 = SQLITE_CONSTRAINT_PRIMARYKEY，2067 = SQLITE_CONSTRAINT_UNIQUE
  if (errcode === 1555 || errcode === 2067) {
    return true;
  }
  const message = (error as { message?: string }).message ?? "";
  return message.includes("UNIQUE constraint failed");
}

export function createSqliteUsageRepository(db: DatabaseSync): UsageRepository {
  return {
    async insertReservation(record: UsageAppend) {
      try {
        db.prepare(
          `INSERT INTO usage_records
             (request_id, user_id, provider_id, model_id, cost_micros, status,
              http_status, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
        ).run(
          record.requestId,
          record.userId,
          record.providerId,
          record.modelId,
          record.costMicros,
          record.httpStatus,
          record.durationMs,
          record.now,
        );
        return true;
      } catch (error) {
        // request_id 是主键：重复提交会命中唯一约束。这属于幂等冲突，
        // 是一个预期的业务结果（返回 false），不能当成数据库故障抛出去。
        if (isUniqueViolation(error)) {
          return false;
        }
        throw error;
      }
    },

    async settle(settlement: UsageSettlement) {
      const result = db
        .prepare(
          `UPDATE usage_records SET
             input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
             cost_micros = ?, status = ?, http_status = COALESCE(?, http_status),
             error_message = ?, settled_at = ?
           WHERE request_id = ? AND status = 'reserved'`,
        )
        .run(
          settlement.usage.inputTokens,
          settlement.usage.outputTokens,
          settlement.usage.cacheReadTokens,
          settlement.usage.cacheWriteTokens,
          settlement.costMicros,
          settlement.status,
          settlement.httpStatus,
          settlement.errorMessage,
          settlement.now,
          settlement.requestId,
        );
      const changes =
        typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
      return changes > 0;
    },

    async findById(requestId) {
      const row = db
        .prepare("SELECT * FROM usage_records WHERE request_id = ?")
        .get(requestId) as unknown as UsageRow | undefined;
      return row ? toUsageRecord(row) : null;
    },

    async sumReservedMicros(userId) {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(cost_micros), 0) AS total FROM usage_records
            WHERE user_id = ? AND status = 'reserved'`,
        )
        .get(userId) as unknown as { total: number };
      return row.total;
    },

    async list({ userId, limit, offset, since }) {
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      if (userId) {
        conditions.push("user_id = ?");
        params.push(userId);
      }
      if (since !== undefined) {
        conditions.push("created_at >= ?");
        params.push(since);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT * FROM usage_records ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as unknown as UsageRow[];
      return rows.map(toUsageRecord);
    },

    async count({ userId, since }) {
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      if (userId) {
        conditions.push("user_id = ?");
        params.push(userId);
      }
      if (since !== undefined) {
        conditions.push("created_at >= ?");
        params.push(since);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const row = db
        .prepare(`SELECT COUNT(*) AS total FROM usage_records ${where}`)
        .get(...params) as unknown as { total: number };
      return row.total;
    },

    async totals({ userId, since }) {
      const conditions: string[] = [SETTLED_PREDICATE];
      const params: (string | number)[] = [];
      if (userId) {
        conditions.push("user_id = ?");
        params.push(userId);
      }
      if (since !== undefined) {
        conditions.push("created_at >= ?");
        params.push(since);
      }
      const row = db
        .prepare(
          `SELECT
             COUNT(*) AS request_count,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
             COALESCE(SUM(cost_micros), 0) AS cost_micros,
             COALESCE(SUM(CASE WHEN status = 'upstream_error' THEN 1 ELSE 0 END), 0) AS error_count
           FROM usage_records WHERE ${conditions.join(" AND ")}`,
        )
        .get(...params) as unknown as Parameters<typeof readTotalsRow>[0];
      return readTotalsRow(row);
    },

    async aggregateByUser({ since, limit }) {
      const conditions: string[] = [SETTLED_PREDICATE];
      const params: (string | number)[] = [];
      if (since !== undefined) {
        conditions.push("created_at >= ?");
        params.push(since);
      }
      const rows = db
        .prepare(
          `SELECT
             user_id,
             COUNT(*) AS request_count,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
             COALESCE(SUM(cost_micros), 0) AS cost_micros,
             COALESCE(SUM(CASE WHEN status = 'upstream_error' THEN 1 ELSE 0 END), 0) AS error_count
           FROM usage_records WHERE ${conditions.join(" AND ")}
           GROUP BY user_id
           ORDER BY cost_micros DESC
           LIMIT ?`,
        )
        .all(...params, limit) as unknown as (Parameters<typeof readTotalsRow>[0] & {
        user_id: string;
      })[];
      return rows.map((row) => ({ userId: row.user_id, totals: readTotalsRow(row) }));
    },

    async releaseStaleReservations({ olderThan, now }) {
      const result = db
        .prepare(
          `UPDATE usage_records SET
             status = 'upstream_error',
             cost_micros = 0,
             error_message = '预扣超时释放',
             settled_at = ?
           WHERE status = 'reserved' AND created_at < ?`,
        )
        .run(now, olderThan);
      const changes =
        typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
      return changes;
    },
  };
}

