/**
 * 预扣与结算的原子事务（审计#6/#7）。
 *
 * 这两步都要同时读写 usage_records、balances、subscriptions 与 ledger_entries，
 * 所以从 usageRepo 拆出来单独放：在一个 BEGIN IMMEDIATE 事务里"读判定 + 写多表"，
 * 并发请求不可能同时通过同一份额度判定，也不会出现"状态已改终态但没记账"的中间态。
 */
import type { DatabaseSync } from "node:sqlite";
import { resolveAvailableMicros } from "../../domain/billing.js";
import { formatMicros } from "../../domain/money.js";
import type {
  ReservationOutcome,
  UsageAppend,
  UsageRepository,
  UsageSettlement,
  UsageSettlementOutcome,
} from "../../app/ports.js";
import { newLedgerEntryId } from "../crypto/ids.js";
import { runInImmediateTransaction } from "./database.js";

/** 只提供需要跨表原子性的两个方法；其余用量读写仍在 usageRepo.ts。 */
export type UsageAtomicOperations = Pick<
  UsageRepository,
  "reserveForRequest" | "settleWithBilling"
>;

interface ActiveSubscriptionRow {
  id: string;
  remaining_micros: number;
}

function readBalanceMicros(db: DatabaseSync, userId: string): number {
  const row = db
    .prepare("SELECT balance_micros FROM balances WHERE user_id = ?")
    .get(userId) as unknown as { balance_micros: number } | undefined;
  return row?.balance_micros ?? 0;
}

/** 未结算的预扣总额；usageRepo 的 sumReservedMicros 也用它。 */
export function readReservedMicros(db: DatabaseSync, userId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_micros), 0) AS total FROM usage_records
        WHERE user_id = ? AND status = 'reserved'`,
    )
    .get(userId) as unknown as { total: number };
  return row.total;
}

/**
 * 当前有效订阅；判定条件与 domain/plans.ts 的 pickActiveSubscription 一致
 * （未撤销、未过期，多个时取最近创建的那个）。
 */
function readActiveSubscription(
  db: DatabaseSync,
  userId: string,
  now: number,
): ActiveSubscriptionRow | null {
  const row = db
    .prepare(
      `SELECT id, remaining_micros FROM subscriptions
        WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId, now) as unknown as ActiveSubscriptionRow | undefined;
  return row ?? null;
}

export function createSqliteUsageAtomicOperations(db: DatabaseSync): UsageAtomicOperations {
  return {
    async reserveForRequest(record: UsageAppend): Promise<ReservationOutcome> {
      // 审计#7：准入判定与预扣写入必须原子。分成两步 await 时，两个并发请求
      // 会同时看到同一份额度，双双写入预扣，直接透支。
      return runInImmediateTransaction(db, (): ReservationOutcome => {
        const existing = db
          .prepare("SELECT 1 AS present FROM usage_records WHERE request_id = ?")
          .get(record.requestId) as unknown as { present: number } | undefined;
        if (existing) {
          return "duplicate";
        }
        const subscription = readActiveSubscription(db, record.userId, record.now);
        const available = resolveAvailableMicros(
          readBalanceMicros(db, record.userId),
          readReservedMicros(db, record.userId),
          subscription?.remaining_micros ?? 0,
        );
        if (available < record.costMicros) {
          return "insufficient_balance";
        }
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
        return "reserved";
      });
    },

    async settleWithBilling(settlement: UsageSettlement): Promise<UsageSettlementOutcome> {
      // 审计#6：改终态、扣套餐、扣余额、写流水必须同一事务。
      // 先改状态再记账的两步写法一旦第二步失败，记录已经是终态，滞留预扣释放兜不住，
      // 用户白嫖一次上游调用；这里失败整体回滚，记录仍停 reserved，可被对账释放。
      return runInImmediateTransaction(db, (): UsageSettlementOutcome => {
        const updated = db
          .prepare(
            `UPDATE usage_records SET
               input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
               cost_micros = ?, status = ?, http_status = COALESCE(?, http_status),
               error_message = ?, settled_at = ?
             WHERE request_id = ? AND user_id = ? AND status = 'reserved'`,
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
            settlement.userId,
          );
        const changes =
          typeof updated.changes === "bigint" ? Number(updated.changes) : updated.changes;
        if (changes === 0) {
          // 已结算过（重试或并发重复回调）：本事务什么都不做，绝不重复记账。
          return { settled: false, fromPlanMicros: 0, fromBalanceMicros: 0, shortfallMicros: 0 };
        }
        if (settlement.costMicros <= 0) {
          // 上游错误 / 被拒 / 零费用：只留记录，不动钱。
          return { settled: true, fromPlanMicros: 0, fromBalanceMicros: 0, shortfallMicros: 0 };
        }

        // 套餐额度优先：有效订阅还有剩余就先抵扣，抵扣不完的部分落到余额。
        let fromPlanMicros = 0;
        const subscription = readActiveSubscription(db, settlement.userId, settlement.now);
        if (subscription) {
          fromPlanMicros = Math.min(
            settlement.costMicros,
            Math.max(0, subscription.remaining_micros),
          );
          if (fromPlanMicros > 0) {
            db.prepare(
              "UPDATE subscriptions SET remaining_micros = remaining_micros - ? WHERE id = ?",
            ).run(fromPlanMicros, subscription.id);
          }
        }

        const dueFromBalance = settlement.costMicros - fromPlanMicros;
        let fromBalanceMicros = 0;
        let shortfallMicros = 0;
        if (dueFromBalance > 0) {
          // 审计#8：封顶用真实余额，而不是"余额 − 预扣 + 套餐"的可用额度——
          // 本请求自己的预扣不是实际扣款，用它会把封顶算低，甚至出现余额不足的假象。
          const balance = readBalanceMicros(db, settlement.userId);
          fromBalanceMicros = Math.min(dueFromBalance, balance);
          shortfallMicros = dueFromBalance - fromBalanceMicros;
          if (fromBalanceMicros > 0) {
            // 流水与余额在同一事务里写：余额是流水的派生值，两者必须一起变。
            db.prepare(
              `INSERT INTO ledger_entries
                 (id, user_id, kind, amount_micros, request_id, note, created_by, created_at)
               VALUES (?, ?, 'usage', ?, ?, ?, NULL, ?)`,
            ).run(
              newLedgerEntryId(),
              settlement.userId,
              -fromBalanceMicros,
              settlement.requestId,
              shortfallMicros > 0
                ? `模型调用扣费（实际费用超出余额 ${formatMicros(shortfallMicros)}，已按余额扣减）`
                : "模型调用扣费",
              settlement.now,
            );
            db.prepare(
              "UPDATE balances SET balance_micros = balance_micros + ?, updated_at = ? WHERE user_id = ?",
            ).run(-fromBalanceMicros, settlement.now, settlement.userId);
          }
        }
        return { settled: true, fromPlanMicros, fromBalanceMicros, shortfallMicros };
      });
    },
  };
}
