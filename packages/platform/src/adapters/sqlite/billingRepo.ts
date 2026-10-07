/**
 * 余额与流水的 SQLite 实现。
 *
 * 关键约束：`applyLedger` 在同一事务里写流水与余额。余额是派生值、流水是事实源，
 * 两者分写会留下无法对账的中间态；因此这里不提供"直接设置余额"的接口。
 * 用量的预扣与结算在 usageRepo.ts。
 */
import type { DatabaseSync } from "node:sqlite";
import type { LedgerEntry, LedgerKind } from "../../domain/billing.js";
import type { BillingRepository, LedgerMutation } from "../../app/ports.js";
import { newLedgerEntryId } from "../crypto/ids.js";

interface BalanceRow {
  balance_micros: number;
}

interface LedgerRow {
  id: string;
  user_id: string;
  kind: string;
  amount_micros: number;
  request_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: number;
}

const LEDGER_KINDS: readonly string[] = ["recharge", "usage", "plan_grant", "adjustment"];

function toLedgerEntry(row: LedgerRow): LedgerEntry {
  if (!LEDGER_KINDS.includes(row.kind)) {
    throw new Error(`未知流水类型：${row.kind}`);
  }
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as LedgerKind,
    amountMicros: row.amount_micros,
    requestId: row.request_id,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function createSqliteBillingRepository(db: DatabaseSync): BillingRepository {
  return {
    async getBalance(userId) {
      const row = db
        .prepare("SELECT balance_micros FROM balances WHERE user_id = ?")
        .get(userId) as unknown as BalanceRow | undefined;
      return row?.balance_micros ?? 0;
    },

    async applyLedger(mutation: LedgerMutation) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO ledger_entries
             (id, user_id, kind, amount_micros, request_id, note, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newLedgerEntryId(),
          mutation.userId,
          mutation.kind,
          mutation.amountMicros,
          mutation.requestId ?? null,
          mutation.note ?? null,
          mutation.createdBy ?? null,
          mutation.now,
        );
        // 余额用"先确保行存在、再原地增量"两步，而不是 INSERT ... ON CONFLICT DO UPDATE：
        // SQLite 会在冲突处理之前就对 VALUES 行求值 CHECK 约束，把负增量（扣费）写进
        // VALUES 会直接违反 CHECK(balance_micros >= 0)，导致扣费永远失败。
        db.prepare(
          `INSERT INTO balances (user_id, balance_micros, updated_at)
           VALUES (?, 0, ?)
           ON CONFLICT(user_id) DO NOTHING`,
        ).run(mutation.userId, mutation.now);
        db.prepare(
          "UPDATE balances SET balance_micros = balance_micros + ?, updated_at = ? WHERE user_id = ?",
        ).run(mutation.amountMicros, mutation.now, mutation.userId);
        // 余额不允许为负：预扣检查在前，这里再兜一层，避免记账逻辑出错时写出负余额。
        const balance = db
          .prepare("SELECT balance_micros FROM balances WHERE user_id = ?")
          .get(mutation.userId) as unknown as BalanceRow | undefined;
        if (balance && balance.balance_micros < 0) {
          throw new Error("余额不足以完成记账");
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async listLedger({ userId, limit, offset }) {
      const rows = (userId
        ? db
            .prepare(
              `SELECT * FROM ledger_entries WHERE user_id = ?
                 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
            )
            .all(userId, limit, offset)
        : db
            .prepare(
              `SELECT * FROM ledger_entries
                 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
            )
            .all(limit, offset)) as unknown as LedgerRow[];
      return rows.map(toLedgerEntry);
    },

    async countLedger(userId) {
      const row = (userId
        ? db.prepare("SELECT COUNT(*) AS total FROM ledger_entries WHERE user_id = ?").get(userId)
        : db.prepare("SELECT COUNT(*) AS total FROM ledger_entries").get()) as unknown as {
        total: number;
      };
      return row.total;
    },

    async recomputeBalance(userId) {
      const row = db
        .prepare(
          "SELECT COALESCE(SUM(amount_micros), 0) AS total FROM ledger_entries WHERE user_id = ?",
        )
        .get(userId) as unknown as { total: number };
      return row.total;
    },

    async sumLedgerSince({ kinds, since }) {
      // kinds 是受控的枚举值（LEDGER_KINDS 子集），IN 占位符参数化，不拼接用户输入。
      const placeholders = kinds.map(() => "?").join(", ");
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(amount_micros), 0) AS total FROM ledger_entries
            WHERE created_at >= ? AND kind IN (${placeholders})`,
        )
        .get(since, ...kinds) as unknown as { total: number };
      return row.total;
    },

    async sumBalances() {
      const row = db
        .prepare("SELECT COALESCE(SUM(balance_micros), 0) AS total FROM balances")
        .get() as unknown as { total: number };
      return row.total;
    },
  };
}
