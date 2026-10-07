/** 会话仓储（SQLite）。表结构见 migrations.ts 的 0001_accounts。 */
import type { DatabaseSync } from "node:sqlite";
import type { SessionRepository } from "../../app/ports.js";
import type { SessionRecord } from "../../domain/session.js";

interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  user_agent: string | null;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    userAgent: row.user_agent,
  };
}

function readChanges(result: { changes: number | bigint }): number {
  return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
}

export function createSqliteSessionRepository(db: DatabaseSync): SessionRepository {
  return {
    async insert(session) {
      db.prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        session.id,
        session.userId,
        session.createdAt,
        session.expiresAt,
        session.revokedAt,
        session.userAgent,
      );
    },

    async findById(id) {
      const row = db
        .prepare(
          `SELECT id, user_id, created_at, expires_at, revoked_at, user_agent
             FROM sessions WHERE id = ?`,
        )
        .get(id) as unknown as SessionRow | undefined;
      return row ? toRecord(row) : null;
    },

    async revoke(id, revokedAt) {
      // 幂等：已撤销的会话保持首次撤销时间，不被后续登出覆盖。
      db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
        revokedAt,
        id,
      );
    },

    async revokeAllForUser(userId, revokedAt) {
      db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(
        revokedAt,
        userId,
      );
    },

    async revokeAllForUserExcept(userId, exceptSessionId, revokedAt) {
      db.prepare(
        `UPDATE sessions SET revoked_at = ?
          WHERE user_id = ? AND revoked_at IS NULL AND id <> ?`,
      ).run(revokedAt, userId, exceptSessionId);
    },

    async deleteExpiredBefore(timestamp) {
      const result = db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(timestamp);
      return readChanges(result);
    },
  };
}
