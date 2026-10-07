/** 管理接口：用量看板。 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { BillingService } from "../../../app/billingService.js";
import type { CatalogService } from "../../../app/catalogService.js";
import { PlatformError } from "../../../domain/errors.js";
import { formatMicros } from "../../../domain/money.js";
import type { ModelPriceRepository, UsageRepository } from "../../../app/ports.js";
import { createAdminGuard, readPagination, readSinceDays } from "./adminSupport.js";

/**
 * 已发布目录里出现、但没有配置单价的模型：帮管理员发现"模型能调但账算不出来"的漏配。
 * 目录内容在保存时已通过结构校验，这里只做宽松读取；没有目录时差集为空。
 */
async function collectUnpricedModels(
  current: { content: string } | null,
  prices: ModelPriceRepository,
): Promise<string[]> {
  if (!current) {
    return [];
  }
  const content = JSON.parse(current.content) as {
    config?: { providerConfigRules?: { providerRules?: unknown[] } };
  };
  const providerRules = content.config?.providerConfigRules?.providerRules ?? [];
  const modelIds = providerRules.flatMap((rule) => {
    // 客户端严格 schema 里 provider 的可见模型清单是 config.builtinModelIds（审计#20）。
    const ids = (rule as { config?: { builtinModelIds?: unknown } }).config?.builtinModelIds;
    if (!Array.isArray(ids)) {
      return [];
    }
    return ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  });
  const unique = [...new Set(modelIds)];
  if (unique.length === 0) {
    return [];
  }
  const priced = new Set((await prices.list()).map((record) => record.modelId));
  // 上限 200：只做提示，不无限增长。
  return unique.filter((modelId) => !priced.has(modelId)).slice(0, 200);
}

export function createAdminUsageRoutes(deps: {
  readonly accounts: AccountService;
  readonly billing: BillingService;
  readonly usage: UsageRepository;
  readonly catalog: CatalogService;
  readonly prices: ModelPriceRepository;
  readonly now: () => number;
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

  // 按模型聚合：看板用它回答"哪个模型最烧钱"，NULL model_id 的记录不参与。
  routes.get("/usage/by-model", async (context) => {
    await requireAdmin(context);
    const since = readSinceDays(context, { defaultDays: 30 });
    const limit = Math.min(Number(context.req.query("limit") ?? 20) || 20, 100);
    const rows = await deps.usage.aggregateByModel({
      limit,
      ...(since !== undefined ? { since } : {}),
    });
    return context.json({
      rows: rows.map((row) => ({
        modelId: row.modelId,
        totals: { ...row.totals, cost: formatMicros(row.totals.costMicros) },
      })),
    });
  });

  // 全站流水：跨用户的账目审计视图，金额形状与 /users/:id/ledger 一致。
  routes.get("/ledger", async (context) => {
    await requireAdmin(context);
    const { limit, offset } = readPagination(context, { defaultLimit: 100 });
    // 不带 userId：listLedger/countLedger 的 userId 可选，缺省即全站。
    const result = await deps.billing.listLedger({ limit, offset });
    return context.json({
      entries: result.entries.map((entry) => ({
        ...entry,
        amount: formatMicros(Math.abs(entry.amountMicros)),
        direction: entry.amountMicros >= 0 ? "credit" : "debit",
      })),
      total: result.total,
      limit,
      offset,
    });
  });

  // 概览：一次请求给看板首页全部数字，避免前端拼五六个接口。
  routes.get("/overview", async (context) => {
    await requireAdmin(context);
    const since30 = readSinceDays(context, { defaultDays: 30 });
    if (since30 === undefined) {
      throw new PlatformError("internal_error", "readSinceDays 带 defaultDays 时必须返回时间戳");
    }
    // 今日按本地时区 0 点起算：运营口径的"今天"是墙上时钟，不是滚动 24 小时。
    const today = new Date(deps.now());
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();

    const [totals30, totalsToday, rechargeTodayMicros, liabilityMicros, userCount, unpricedModels] =
      await Promise.all([
        deps.billing.getUsageTotals({ since: since30 }),
        deps.billing.getUsageTotals({ since: todayStart }),
        deps.billing.sumLedgerSince({ kinds: ["recharge"], since: todayStart }),
        deps.billing.sumBalances(),
        deps.accounts.countUsers(),
        deps.catalog.readCurrent().then((current) => collectUnpricedModels(current, deps.prices)),
      ]);
    return context.json({
      totals30,
      totalsToday,
      rechargeTodayMicros,
      rechargeToday: formatMicros(rechargeTodayMicros),
      costTodayMicros: totalsToday.costMicros,
      costToday: formatMicros(totalsToday.costMicros),
      liabilityMicros,
      liability: formatMicros(liabilityMicros),
      userCount,
      unpricedModels,
    });
  });

  return routes;
}
