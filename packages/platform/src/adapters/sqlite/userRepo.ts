/** 用户仓储（SQLite）。表结构见 migrations.ts 的 0001_accounts。 */
import type { DatabaseSync } from "node:sqlite";
import type { UserRepository } from "../../app/ports.js";
import type { PlatformRole, UserRecord, UserStatus } from "../../domain/user.js";

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: number;
  updated_at: number;
}

const SELECT_COLUMNS =
  "id, email, display_name, password_hash, role, status, created_at, updated_at";

/**
 * 数据库里受 CHECK 约束的枚举取出来仍是 string；这里显式收窄，
 * 让 schema 被外部改动这类问题在读取点立刻暴露，而不是悄悄流进领域逻辑。
 */
function toRecord(row: UserRow): UserRecord {
  if (row.role !== "admin" && row.role !== "user") {
    throw new Error(`未知用户角色：${row.role}`);
  }
  if (row.status !== "active" && row.status !== "disabled") {
    throw new Error(`未知用户状态：${row.status}`);
  }
  const role: PlatformRole = row.role;
  const status: UserStatus = row.status;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role,
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSqliteUserRepository(db: DatabaseSync): UserRepository {
  return {
    async insert(user) {
      db.prepare(
        `INSERT INTO users (${SELECT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        user.id,
        user.email,
        user.displayName,
        user.passwordHash,
        user.role,
        user.status,
        user.createdAt,
        user.updatedAt,
      );
    },

    async update(user) {
      const result = db
        .prepare(
          `UPDATE users
             SET email = ?, display_name = ?, password_hash = ?, role = ?, status = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          user.email,
          user.displayName,
          user.passwordHash,
          user.role,
          user.status,
          user.updatedAt,
          user.id,
        );
      if (result.changes === 0) {
        throw new Error(`用户不存在，无法更新：${user.id}`);
      }
    },

    async findById(id) {
      const row = db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM users WHERE id = ?`)
        .get(id) as unknown as UserRow | undefined;
      return row ? toRecord(row) : null;
    },

    async findByEmail(email) {
      const row = db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM users WHERE email = ?`)
        .get(email) as unknown as UserRow | undefined;
      return row ? toRecord(row) : null;
    },

    async existsWithRole(role) {
      const row = db
        .prepare("SELECT 1 AS present FROM users WHERE role = ? LIMIT 1")
        .get(role) as unknown as { present: number } | undefined;
      return row !== undefined;
    },

    async list({ limit, offset }) {
      const rows = db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM users ORDER BY created_at ASC LIMIT ? OFFSET ?`)
        .all(limit, offset) as unknown as UserRow[];
      return rows.map(toRecord);
    },

    async count() {
      const row = db.prepare("SELECT COUNT(*) AS total FROM users").get() as unknown as {
        total: number;
      };
      return row.total;
    },
  };
}
