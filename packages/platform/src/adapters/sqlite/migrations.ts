/**
 * 平台数据库迁移。
 *
 * 沿用 tasks-index 的做法：迁移内容参与 checksum，已应用的迁移不容许被改写
 * （改了就会在启动时直接失败，而不是让老库带着半新半旧的 schema 继续跑）。
 * 因此这里的 SQL 一旦发布就冻结，新增改动一律追加新的迁移条目。
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

interface MigrationDefinition {
  readonly id: string;
  readonly statements: readonly string[];
}

const USERS_AND_SESSIONS = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX idx_users_created_at ON users(created_at DESC);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    user_agent TEXT
  );

  CREATE INDEX idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
`;

/**
 * 网关、计量与计费。
 *
 * 设计要点：
 * - 上游 API key 只存在这张表的 gateway_providers 里，永不下发到客户端。
 * - 余额的唯一事实源是 balances.balance_micros，且只在写入 ledger_entries 的同一事务里变化；
 *   ledger 是完整流水，可用它重算余额对账。
 * - 预扣用 usage_records 里 status='reserved' 的行表达，不额外建表：
 *   可用余额 = balance - SUM(未结算的 cost)。请求结束把该行改成 ok/error 即完成结算。
 * - request_id 同时在 usage_records 主键与 ledger 的部分唯一索引上做幂等。
 */
const GATEWAY_BILLING = `
  CREATE TABLE gateway_providers (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    upstream_base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    protocol TEXT NOT NULL CHECK (protocol IN ('anthropic', 'openai', 'openai-compatible')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE model_prices (
    model_id TEXT PRIMARY KEY,
    input_micros_per_million INTEGER NOT NULL DEFAULT 0,
    output_micros_per_million INTEGER NOT NULL DEFAULT 0,
    cache_read_micros_per_million INTEGER NOT NULL DEFAULT 0,
    cache_write_micros_per_million INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE balances (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance_micros INTEGER NOT NULL DEFAULT 0 CHECK (balance_micros >= 0),
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE ledger_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('recharge', 'usage', 'plan_grant', 'adjustment')),
    amount_micros INTEGER NOT NULL,
    request_id TEXT,
    note TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX idx_ledger_request_id ON ledger_entries(request_id)
    WHERE request_id IS NOT NULL;
  CREATE INDEX idx_ledger_user_time ON ledger_entries(user_id, created_at DESC);

  CREATE TABLE usage_records (
    request_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    model_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_micros INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'ok', 'upstream_error', 'rejected')),
    http_status INTEGER,
    duration_ms INTEGER,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  );

  CREATE INDEX idx_usage_user_time ON usage_records(user_id, created_at DESC);
  CREATE INDEX idx_usage_status ON usage_records(status);

  CREATE TABLE model_catalog (
    revision INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );
`;

/** 套餐、订阅与客户端发布登记。 */
const PLANS_AND_RELEASES = `
  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    quota_micros INTEGER NOT NULL DEFAULT 0,
    duration_days INTEGER,
    allowed_models_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    remaining_micros INTEGER NOT NULL DEFAULT 0,
    starts_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX idx_subscriptions_user ON subscriptions(user_id, created_at DESC);

  CREATE TABLE releases (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('stable', 'preview')),
    platform TEXT NOT NULL,
    file_name TEXT NOT NULL,
    sha512 TEXT NOT NULL,
    size_bytes INTEGER,
    release_notes TEXT,
    created_at INTEGER NOT NULL
  );

  -- 同一版本在同一平台同一通道只应有一条登记；重复发布走 upsert 覆盖。
  CREATE UNIQUE INDEX idx_releases_unique ON releases(version, platform, channel);
`;

const DEFINITIONS: readonly MigrationDefinition[] = [
  {
    id: "0001_accounts",
    statements: [USERS_AND_SESSIONS],
  },
  {
    id: "0002_gateway_billing",
    statements: [GATEWAY_BILLING],
  },
  {
    id: "0003_plans_and_releases",
    statements: [PLANS_AND_RELEASES],
  },
];

const CHECKSUM_TAG = "zcode-platform-migration-v1";

function checksumOf(definition: MigrationDefinition): string {
  return createHash("sha256")
    .update(CHECKSUM_TAG)
    .update("\0")
    .update(definition.id)
    .update("\0")
    .update(definition.statements.join("\n"))
    .digest("hex");
}

export const PLATFORM_MIGRATION_IDS = DEFINITIONS.map((definition) => definition.id);

interface AppliedMigrationRow {
  id: string;
  checksum: string;
}

function readApplied(db: DatabaseSync): Map<string, string> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_schema_migration (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const rows = db
    .prepare("SELECT id, checksum FROM platform_schema_migration")
    .all() as unknown as AppliedMigrationRow[];
  return new Map(rows.map((row) => [row.id, row.checksum]));
}

/**
 * 应用所有未执行的迁移。返回本次实际执行的迁移 id，便于启动日志区分"新库"与"已是最新"。
 */
export function runPlatformMigrations(db: DatabaseSync, now: () => number): string[] {
  const applied = readApplied(db);
  const executed: string[] = [];

  for (const definition of DEFINITIONS) {
    const checksum = checksumOf(definition);
    const existing = applied.get(definition.id);
    if (existing !== undefined) {
      if (existing !== checksum) {
        throw new Error(
          `平台迁移 ${definition.id} 的内容已被改写（记录 checksum ${existing}，当前 ${checksum}）。` +
            "已发布的迁移必须保持不变，请追加新迁移。",
        );
      }
      continue;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of definition.statements) {
        db.exec(statement);
      }
      db.prepare(
        "INSERT INTO platform_schema_migration (id, checksum, applied_at) VALUES (?, ?, ?)",
      ).run(definition.id, checksum, now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    executed.push(definition.id);
  }

  return executed;
}
