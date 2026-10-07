/**
 * 运营基建的 SQLite 实现：审计日志、系统设置、兑换码、用户 API Key。
 * 语义与事务边界见 specs/platform/operations.md。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  ApiKeyRecord,
  AuditAppend,
  AuditLogEntry,
  RedeemCodeRecord,
  RedeemRedemptionRecord,
  SettingKey,
} from "../../domain/operations.js";
import type {
  ApiKeyRepository,
  AuditRepository,
  RedeemRepository,
  SettingsRepository,
} from "../../app/ports.js";
import { newAuditLogId, newRedemptionId } from "../crypto/ids.js";

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string | null;
  created_at: number;
}

interface RedeemCodeRow {
  id: string;
  code: string;
  amount_micros: number;
  max_redemptions: number;
  redeemed_count: number;
  expires_at: number | null;
  created_by: string | null;
  revoked_at: number | null;
  created_at: number;
}

interface RedemptionRow {
  id: string;
  code_id: string;
  user_id: string;
  amount_micros: number;
  redeemed_at: number;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  key_hash: string;
  key_hint: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

function toAudit(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

function toRedeemCode(row: RedeemCodeRow): RedeemCodeRecord {
  return {
    id: row.id,
    code: row.code,
    amountMicros: row.amount_micros,
    maxRedemptions: row.max_redemptions,
    redeemedCount: row.redeemed_count,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function toApiKey(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    keyHash: row.key_hash,
    keyHint: row.key_hint,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export function createSqliteAuditRepository(db: DatabaseSync): AuditRepository {
  return {
    async append(entry: AuditAppend) {
      db.prepare(
        `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newAuditLogId(),
        entry.actorUserId ?? null,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.detail ?? null,
        entry.now,
      );
    },

    async list(options) {
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      if (options.action) {
        conditions.push("action = ?");
        params.push(options.action);
      }
      if (options.actor) {
        conditions.push("actor_user_id = ?");
        params.push(options.actor);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, options.limit, options.offset) as unknown as AuditRow[];
      const countRow = db
        .prepare(`SELECT COUNT(*) AS total FROM audit_logs ${where}`)
        .get(...params) as unknown as { total: number };
      return { entries: rows.map(toAudit), total: countRow.total };
    },
  };
}

export function createSqliteSettingsRepository(db: DatabaseSync): SettingsRepository {
  return {
    async read(key: SettingKey) {
      const row = db
        .prepare("SELECT value FROM system_settings WHERE key = ?")
        .get(key) as unknown as { value: string } | undefined;
      return row?.value ?? null;
    },

    async readAll() {
      const rows = db.prepare("SELECT key, value FROM system_settings").all() as unknown as {
        key: string;
        value: string;
      }[];
      return new Map(rows.map((row) => [row.key, row.value]));
    },

    async write(key, value, updatedBy, now) {
      db.prepare(
        `INSERT INTO system_settings (key, value, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      ).run(key, value, now, updatedBy ?? null);
    },
  };
}

export function createSqliteRedeemRepository(db: DatabaseSync): RedeemRepository {
  const toRedemption = (row: RedemptionRow): RedeemRedemptionRecord => ({
    id: row.id,
    codeId: row.code_id,
    userId: row.user_id,
    amountMicros: row.amount_micros,
    redeemedAt: row.redeemed_at,
  });

  return {
    async findByCode(code) {
      const row = db.prepare("SELECT * FROM redeem_codes WHERE code = ?").get(code) as unknown as
        | RedeemCodeRow
        | undefined;
      return row ? toRedeemCode(row) : null;
    },

    async findById(id) {
      const row = db.prepare("SELECT * FROM redeem_codes WHERE id = ?").get(id) as unknown as
        | RedeemCodeRow
        | undefined;
      return row ? toRedeemCode(row) : null;
    },

    async list() {
      const rows = db
        .prepare("SELECT * FROM redeem_codes ORDER BY created_at DESC")
        .all() as unknown as RedeemCodeRow[];
      return rows.map(toRedeemCode);
    },

    async insert(record) {
      db.prepare(
        `INSERT INTO redeem_codes
           (id, code, amount_micros, max_redemptions, redeemed_count, expires_at, created_by, revoked_at, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.code,
        record.amountMicros,
        record.maxRedemptions,
        record.expiresAt,
        record.createdBy,
        record.revokedAt,
        record.createdAt,
      );
    },

    async revoke(id, now) {
      db.prepare("UPDATE redeem_codes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
        now,
        id,
      );
    },

    /** 防超发的完整核销事务：重数、过期、吊销、单人一次在锁内逐项判定。 */
    async redeem(options) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const codeRow = db
          .prepare("SELECT * FROM redeem_codes WHERE id = ?")
          .get(options.codeId) as unknown as RedeemCodeRow | undefined;
        if (!codeRow) {
          db.exec("ROLLBACK");
          return "not_found";
        }
        if (codeRow.revoked_at !== null) {
          db.exec("ROLLBACK");
          return "revoked";
        }
        if (codeRow.expires_at !== null && codeRow.expires_at <= options.now) {
          db.exec("ROLLBACK");
          return "expired";
        }
        if (codeRow.redeemed_count >= codeRow.max_redemptions) {
          db.exec("ROLLBACK");
          return "exhausted";
        }
        const already = db
          .prepare("SELECT 1 AS present FROM redeem_redemptions WHERE code_id = ? AND user_id = ?")
          .get(options.codeId, options.userId) as unknown as { present: number } | undefined;
        if (already) {
          db.exec("ROLLBACK");
          return "already_redeemed";
        }
        db.prepare("UPDATE redeem_codes SET redeemed_count = redeemed_count + 1 WHERE id = ?").run(
          options.codeId,
        );
        const redemptionId = newRedemptionId();
        db.prepare(
          `INSERT INTO redeem_redemptions (id, code_id, user_id, amount_micros, redeemed_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(redemptionId, options.codeId, options.userId, codeRow.amount_micros, options.now);
        db.exec("COMMIT");
        return {
          id: redemptionId,
          codeId: options.codeId,
          userId: options.userId,
          amountMicros: codeRow.amount_micros,
          redeemedAt: options.now,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async listRedemptionsByUser(userId) {
      const rows = db
        .prepare("SELECT * FROM redeem_redemptions WHERE user_id = ? ORDER BY redeemed_at DESC")
        .all(userId) as unknown as RedemptionRow[];
      return rows.map(toRedemption);
    },

    async countRedemptionsByCode(codeId) {
      const row = db
        .prepare("SELECT COUNT(*) AS total FROM redeem_redemptions WHERE code_id = ?")
        .get(codeId) as unknown as { total: number };
      return row.total;
    },
  };
}

export function createSqliteApiKeyRepository(db: DatabaseSync): ApiKeyRepository {
  return {
    async insert(record) {
      db.prepare(
        `INSERT INTO api_keys (id, user_id, key_hash, key_hint, name, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        record.id,
        record.userId,
        record.keyHash,
        record.keyHint,
        record.name,
        record.createdAt,
      );
    },

    async findByHash(keyHash) {
      const row = db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(keyHash) as unknown as
        | ApiKeyRow
        | undefined;
      return row ? toApiKey(row) : null;
    },

    async listByUser(userId) {
      const rows = db
        .prepare("SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC")
        .all(userId) as unknown as ApiKeyRow[];
      return rows.map(toApiKey);
    },

    async listAll() {
      const rows = db
        .prepare("SELECT * FROM api_keys ORDER BY created_at DESC")
        .all() as unknown as ApiKeyRow[];
      return rows.map(toApiKey);
    },

    async revoke(id, now) {
      db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
        now,
        id,
      );
    },

    async touchLastUsed(id, now) {
      db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, id);
    },

    async revokeAllForUser(userId, now) {
      db.prepare("UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(
        now,
        userId,
      );
    },
  };
}
