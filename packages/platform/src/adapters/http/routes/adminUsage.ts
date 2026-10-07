/** 管理接口：用量看板。 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { BillingService } from "../../../app/billingService.js";
import { formatMicros } from "../../../domain/money.js";
import type { UsageRepository } from "../../../app/ports.js";
import { createAdminGuard, readPagination, readSinceDays } from "./adminSupport.js";

export function createAdminUsageRoutes(deps: {
  readonly accounts: AccountService;
  readonly billing: BillingService;
  readonly usage: UsageRepository;
}): Hono {
  const routes = new Hono();
  const requireAdmin = createAdminGuard(deps.accounts);

  routes.get("/usage", async (context) => {
    await requireAdmin(context);
    const { limit, offset } = readPagination(context, { defaultLimit: 100 });
    const since = readSinceDays(context, { defaultDays: 30 });
    const userId = context.req.query("userId")?.trim() || undefined;
    // 默认看最近 30 天：用量表会随时间增长，看板不该默认全表扫描。
    const page = await deps.billing.listUsage({
      limit,
      offset,
      ...(userId ? { userId } : {}),
      ...(since !== undefined ? { since } : {}),
    });
    return context.json({
      records: page.records.map((record) => ({
        requestId: record.requestId,
        userId: record.userId,
        providerId: record.providerId,
        modelId: record.modelId,
        status: record.status,
        tokens: record.usage,
        costMicros: record.costMicros,
        cost: formatMicros(record.costMicros),
        httpStatus: record.httpStatus,
        errorMessage: record.errorMessage,
        createdAt: record.createdAt,
      })),
      total: page.total,
      limit,
      offset,
    });
  });

  routes.get("/usage/totals", async (context) => {
    await requireAdmin(context);
    const since = readSinceDays(context, { defaultDays: 30 });
    const userId = context.req.query("userId")?.trim() || undefined;
    const totals = await deps.billing.getUsageTotals({
      ...(userId ? { userId } : {}),
      ...(since !== undefined ? { since } : {}),
    });
    return context.json({ totals: { ...totals, cost: formatMicros(totals.costMicros) } });
  });

  routes.get("/usage/by-user", async (context) => {
    await requireAdmin(context);
    const since = readSinceDays(context, { defaultDays: 30 });
    const limit = Math.min(Number(context.req.query("limit") ?? 20) || 20, 100);
    const rows = await deps.usage.aggregateByUser({
      limit,
      ...(since !== undefined ? { since } : {}),
    });
    // 带上邮箱，看板才可读；用户可能已被删除，因此缺失时退化为 id。
    const users = await Promise.all(
      rows.map(async (row) => {
        const user = await deps.accounts.getUser(row.userId).catch(() => null);
        return {
          userId: row.userId,
          email: user?.email ?? null,
          totals: { ...row.totals, cost: formatMicros(row.totals.costMicros) },
        };
      }),
    );
    return context.json({ users });
  });

  return routes;
}
