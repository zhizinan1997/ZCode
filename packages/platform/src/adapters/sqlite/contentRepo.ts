/** 模型目录、套餐订阅与客户端发布的 SQLite 实现。 */
import type { DatabaseSync } from "node:sqlite";
import type { PlanRecord, SubscriptionRecord } from "../../domain/plans.js";
import type { ReleaseChannel, ReleaseRecord } from "../../domain/releases.js";
import { isReleaseChannel } from "../../domain/releases.js";
import type {
  CatalogRepository,
  PlanRepository,
  ReleaseRepository,
} from "../../app/ports.js";

interface CatalogRow {
  revision: number;
  content: string;
}

interface PlanRow {
  id: string;
  name: string;
  quota_micros: number;
  duration_days: number | null;
  allowed_models_json: string;
  created_at: number;
  updated_at: number;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_id: string;
  remaining_micros: number;
  starts_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

interface ReleaseRow {
  id: string;
  version: string;
  channel: string;
  platform: string;
  file_name: string;
  sha512: string;
  size_bytes: number | null;
  release_notes: string | null;
  created_at: number;
}

export function createSqliteCatalogRepository(db: DatabaseSync): CatalogRepository {
  return {
    async readCurrent() {
      const row = db
        .prepare("SELECT revision, content FROM model_catalog ORDER BY revision DESC LIMIT 1")
        .get() as unknown as CatalogRow | undefined;
      return row ? { revision: row.revision, content: row.content } : null;
    },

    async readByRevision(revision) {
      const row = db
        .prepare("SELECT revision, content FROM model_catalog WHERE revision = ?")
        .get(revision) as unknown as CatalogRow | undefined;
      return row ? { revision: row.revision, content: row.content } : null;
    },

    async write({ content, revision, expectedRevision, updatedBy, now }) {
      // 乐观并发：管理员可能同时开着两个后台页面。revision 不匹配时拒绝写入，
      // 避免把另一份修改静默覆盖掉。
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = db
          .prepare("SELECT revision, content FROM model_catalog ORDER BY revision DESC LIMIT 1")
          .get() as unknown as CatalogRow | undefined;
        const currentRevision = current?.revision ?? null;
        if (currentRevision !== expectedRevision) {
          throw new Error(
            `目录已被其他修改更新（期望 revision ${String(expectedRevision)}，当前 ${String(currentRevision)}），请重新加载后再保存`,
          );
        }
        db.prepare(
          "INSERT INTO model_catalog (revision, content, updated_at, updated_by) VALUES (?, ?, ?, ?)",
        ).run(revision, content, now, updatedBy);
        db.exec("COMMIT");
        return revision;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function parseAllowedModels(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // 数据损坏时按"不限制"处理会让受限套餐意外放开，因此宁可当作无模型可用。
    return [];
  }
  return [];
}

function toPlan(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    name: row.name,
    quotaMicros: row.quota_micros,
    durationDays: row.duration_days,
    allowedModels: parseAllowedModels(row.allowed_models_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSubscription(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    planId: row.plan_id,
    remainingMicros: row.remaining_micros,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export function createSqlitePlanRepository(db: DatabaseSync): PlanRepository {
  return {
    async listPlans() {
      const rows = db
        .prepare("SELECT * FROM plans ORDER BY created_at DESC")
        .all() as unknown as PlanRow[];
      return rows.map(toPlan);
    },

    async findPlan(planId) {
      const row = db
        .prepare("SELECT * FROM plans WHERE id = ?")
        .get(planId) as unknown as PlanRow | undefined;
      return row ? toPlan(row) : null;
    },

    async upsertPlan(plan) {
      db.prepare(
        `INSERT INTO plans (id, name, quota_micros, duration_days, allowed_models_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           quota_micros = excluded.quota_micros,
           duration_days = excluded.duration_days,
           allowed_models_json = excluded.allowed_models_json,
           updated_at = excluded.updated_at`,
      ).run(
        plan.id,
        plan.name,
        plan.quotaMicros,
        plan.durationDays,
        JSON.stringify(plan.allowedModels),
        plan.createdAt,
        plan.updatedAt,
      );
    },

    async removePlan(planId) {
      db.prepare("DELETE FROM plans WHERE id = ?").run(planId);
    },

    async listSubscriptions(userId) {
      const rows = db
        .prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC")
        .all(userId) as unknown as SubscriptionRow[];
      return rows.map(toSubscription);
    },

    async countSubscriptionsByPlan(planId) {
      const row = db
        .prepare("SELECT COUNT(*) AS total FROM subscriptions WHERE plan_id = ?")
        .get(planId) as unknown as { total: number };
      return row.total;
    },

    async findSubscription(subscriptionId) {
      const row = db
        .prepare("SELECT * FROM subscriptions WHERE id = ?")
        .get(subscriptionId) as unknown as SubscriptionRow | undefined;
      return row ? toSubscription(row) : null;
    },

    async upsertSubscription(subscription) {
      db.prepare(
        `INSERT INTO subscriptions
           (id, user_id, plan_id, remaining_micros, starts_at, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           plan_id = excluded.plan_id,
           remaining_micros = excluded.remaining_micros,
           starts_at = excluded.starts_at,
           expires_at = excluded.expires_at,
           revoked_at = excluded.revoked_at`,
      ).run(
        subscription.id,
        subscription.userId,
        subscription.planId,
        subscription.remainingMicros,
        subscription.startsAt,
        subscription.expiresAt,
        subscription.revokedAt,
        subscription.createdAt,
      );
    },

    async revokeSubscriptions(userId, now) {
      db.prepare(
        "UPDATE subscriptions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      ).run(now, userId);
    },

    async consumeSubscriptionQuota({ subscriptionId, amountMicros }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare("SELECT remaining_micros FROM subscriptions WHERE id = ?")
          .get(subscriptionId) as unknown as { remaining_micros: number } | undefined;
        if (!row) {
          db.exec("COMMIT");
          return 0;
        }
        const consumed = Math.min(Math.max(0, amountMicros), row.remaining_micros);
        if (consumed > 0) {
          db.prepare(
            "UPDATE subscriptions SET remaining_micros = remaining_micros - ? WHERE id = ?",
          ).run(consumed, subscriptionId);
        }
        db.exec("COMMIT");
        return consumed;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export function createSqliteReleaseRepository(db: DatabaseSync): ReleaseRepository {
  const toRecord = (row: ReleaseRow): ReleaseRecord => {
    if (!isReleaseChannel(row.channel)) {
      throw new Error(`未知发布通道：${row.channel}`);
    }
    const channel: ReleaseChannel = row.channel;
    return {
      id: row.id,
      version: row.version,
      channel,
      platform: row.platform,
      fileName: row.file_name,
      sha512: row.sha512,
      sizeBytes: row.size_bytes,
      releaseNotes: row.release_notes,
      createdAt: row.created_at,
    };
  };

  return {
    async upsert(record) {
      db.prepare(
        `INSERT INTO releases
           (id, version, channel, platform, file_name, sha512, size_bytes, release_notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(version, platform, channel) DO UPDATE SET
           file_name = excluded.file_name,
           sha512 = excluded.sha512,
           size_bytes = excluded.size_bytes,
           release_notes = excluded.release_notes`,
      ).run(
        record.id,
        record.version,
        record.channel,
        record.platform,
        record.fileName,
        record.sha512,
        record.sizeBytes,
        record.releaseNotes,
        record.createdAt,
      );
    },

    async list() {
      const rows = db
        .prepare("SELECT * FROM releases ORDER BY created_at DESC")
        .all() as unknown as ReleaseRow[];
      return rows.map(toRecord);
    },

    async listByTag({ channel, platform }) {
      const rows = db
        .prepare("SELECT * FROM releases WHERE channel = ? AND platform = ?")
        .all(channel, platform) as unknown as ReleaseRow[];
      return rows.map(toRecord);
    },

    async findById(id) {
      const row = db
        .prepare("SELECT * FROM releases WHERE id = ?")
        .get(id) as unknown as ReleaseRow | undefined;
      return row ? toRecord(row) : null;
    },

    async remove(id) {
      db.prepare("DELETE FROM releases WHERE id = ?").run(id);
    },
  };
}
