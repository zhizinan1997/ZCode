/**
 * 管理接口：用户、余额、流水、套餐发放。
 *
 * 金额一律以十进制字符串进出（如 "12.5"），由服务端转成整数微元：
 * 让管理员在表单里直接写货币单位，同时避免浮点进入记账链路。
 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { BillingService } from "../../../app/billingService.js";
import type { PlanService } from "../../../app/planService.js";
import { PlatformError } from "../../../domain/errors.js";
import { formatMicros, microsFromDecimalString, type Micros } from "../../../domain/money.js";
import {
  PLATFORM_ROLES,
  USER_STATUSES,
  toPublicUser,
  type UserRecord,
} from "../../../domain/user.js";
import { readEnum, readJsonObject, readString } from "../helpers.js";
import { createAdminGuard, readPagination, readSinceDays, type AdminResolver } from "./adminSupport.js";

/**
 * 用户列表/新建/修改统一返回这个扁平视图：用户字段与余额、套餐平铺在一层，
 * 管理页面不需要区分 `.user.email` 与 `.email` 两种写法。
 */
interface UserSummaryView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
  readonly createdAt: number;
  readonly balanceMicros: Micros;
  readonly availableMicros: Micros;
  readonly planName: string | null;
  readonly planRemainingMicros: Micros | null;
}

function parseAmount(raw: string, label: string): Micros {
  try {
    return microsFromDecimalString(raw);
  } catch (error) {
    throw new PlatformError(
      "invalid_request",
      `${label}格式不正确（非负十进制，最多 6 位小数）：${raw}`,
      { cause: error },
    );
  }
}

export function createAdminUserRoutes(deps: {
  readonly accounts: AccountService;
  readonly billing: BillingService;
  readonly plans: PlanService;
}): Hono {
  const routes = new Hono();
  const requireAdmin: AdminResolver = createAdminGuard(deps.accounts);

  const summarize = async (user: UserRecord): Promise<UserSummaryView> => {
    const summary = await deps.billing.getSummary(user.id);
    return {
      ...toPublicUser(user),
      balanceMicros: summary.balanceMicros,
      availableMicros: summary.availableMicros,
      planName: summary.plan?.name ?? null,
      planRemainingMicros: summary.subscription?.remainingMicros ?? null,
    };
  };

  routes.get("/users", async (context) => {
    await requireAdmin(context);
    const { limit, offset } = readPagination(context);
    const page = await deps.accounts.listUsers({ limit, offset });
    // 余额与套餐一起返回：管理后台的用户列表需要一眼看到"谁还有钱"，
    // 让前端逐行再查一次会产生 N+1 请求。
    const users = await Promise.all(page.users.map(summarize));
    return context.json({ users, total: page.total, limit, offset });
  });

  routes.post("/users", async (context) => {
    await requireAdmin(context);
    const body = await readJsonObject(context);
    const created = await deps.accounts.createUser({
      email: readString(body, "email", { required: true, maxLength: 254 }),
      password: readString(body, "password", { required: true, maxLength: 200 }),
      displayName: readString(body, "displayName", { maxLength: 100 }) || undefined,
      role: readEnum(body, "role", PLATFORM_ROLES),
    });
    return context.json({ user: await summarize(created) }, 201);
  });

  routes.get("/users/:id", async (context) => {
    await requireAdmin(context);
    const userId = context.req.param("id");
    const [user, summary, subscriptions] = await Promise.all([
      deps.accounts.getUser(userId),
      deps.billing.getSummary(userId),
      deps.plans.listSubscriptions(userId),
    ]);
    return context.json({
      user: toPublicUser(user),
      balance: {
        balanceMicros: summary.balanceMicros,
        reservedMicros: summary.reservedMicros,
        availableMicros: summary.availableMicros,
        balance: formatMicros(summary.balanceMicros),
        available: formatMicros(summary.availableMicros),
      },
      plan: summary.plan,
      subscription: summary.subscription,
      subscriptions,
    });
  });

  routes.patch("/users/:id", async (context) => {
    await requireAdmin(context);
    const userId = context.req.param("id");
    const body = await readJsonObject(context);
    const role = readEnum(body, "role", PLATFORM_ROLES);
    const status = readEnum(body, "status", USER_STATUSES);
    if (role === undefined && status === undefined) {
      throw new PlatformError("invalid_request", "至少需要提供 role 或 status");
    }
    if (role !== undefined) {
      await deps.accounts.setUserRole(userId, role);
    }
    if (status !== undefined) {
      await deps.accounts.setUserStatus({ userId, status });
    }
    return context.json({ user: await summarize(await deps.accounts.getUser(userId)) });
  });

  routes.post("/users/:id/password", async (context) => {
    await requireAdmin(context);
    const userId = context.req.param("id");
    const body = await readJsonObject(context);
    await deps.accounts.resetPassword(
      userId,
      readString(body, "newPassword", { required: true, maxLength: 200, label: "新密码" }),
    );
    return context.body(null, 204);
  });

  routes.post("/users/:id/recharge", async (context) => {
    const admin = await requireAdmin(context);
    const userId = context.req.param("id");
    await deps.accounts.getUser(userId);
    const body = await readJsonObject(context);
    const amountMicros = parseAmount(
      readString(body, "amount", { required: true, maxLength: 32, label: "充值金额" }),
      "充值金额",
    );
    if (amountMicros <= 0) {
      throw new PlatformError("invalid_request", "充值金额必须大于 0");
    }
    await deps.billing.recharge({
      userId,
      amountMicros,
      note: readString(body, "note", { maxLength: 200 }) || null,
      createdBy: admin.user.id,
    });
    return context.json({ user: await summarize(await deps.accounts.getUser(userId)) });
  });

  routes.post("/users/:id/adjust", async (context) => {
    const admin = await requireAdmin(context);
    const userId = context.req.param("id");
    await deps.accounts.getUser(userId);
    const body = await readJsonObject(context);
    const raw = readString(body, "delta", { required: true, maxLength: 32, label: "调整金额" });
    const positive = !raw.trim().startsWith("-");
    const magnitude = parseAmount(positive ? raw : raw.trim().slice(1), "调整金额");
    if (magnitude === 0) {
      throw new PlatformError("invalid_request", "调整金额必须非零");
    }
    await deps.billing.adjust({
      userId,
      deltaMicros: positive ? magnitude : -magnitude,
      note: readString(body, "note", { maxLength: 200 }) || null,
      createdBy: admin.user.id,
    });
    return context.json({ user: await summarize(await deps.accounts.getUser(userId)) });
  });

  routes.get("/users/:id/ledger", async (context) => {
    await requireAdmin(context);
    const { limit, offset } = readPagination(context);
    const result = await deps.billing.listLedger({
      userId: context.req.param("id"),
      limit,
      offset,
    });
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

  routes.get("/users/:id/reconcile", async (context) => {
    await requireAdmin(context);
    const result = await deps.billing.reconcileBalance(context.req.param("id"));
    return context.json({
      storedMicros: result.stored,
      recomputedMicros: result.recomputed,
      driftMicros: result.drift,
      consistent: result.drift === 0,
    });
  });

  routes.get("/users/:id/usage", async (context) => {
    await requireAdmin(context);
    const userId = context.req.param("id");
    const { limit, offset } = readPagination(context);
    const since = readSinceDays(context);
    const [page, totals] = await Promise.all([
      deps.billing.listUsage({
        userId,
        limit,
        offset,
        ...(since !== undefined ? { since } : {}),
      }),
      deps.billing.getUsageTotals({ userId, ...(since !== undefined ? { since } : {}) }),
    ]);
    return context.json({ records: page.records, total: page.total, totals, limit, offset });
  });

  routes.post("/users/:id/subscription", async (context) => {
    const admin = await requireAdmin(context);
    const userId = context.req.param("id");
    await deps.accounts.getUser(userId);
    const body = await readJsonObject(context);
    const planId = readString(body, "planId", { required: true, maxLength: 200, label: "套餐" });
    const subscription = await deps.plans.grantSubscription({
      userId,
      planId,
      createdBy: admin.user.id,
    });
    return context.json({ subscription }, 201);
  });

  routes.delete("/users/:id/subscription", async (context) => {
    await requireAdmin(context);
    const userId = context.req.param("id");
    await deps.accounts.getUser(userId);
    await deps.plans.revokeSubscriptions(userId);
    return context.body(null, 204);
  });

  routes.get("/users/:id/subscriptions", async (context) => {
    await requireAdmin(context);
    const subscriptions = await deps.plans.listSubscriptions(context.req.param("id"));
    return context.json({ subscriptions });
  });

  return routes;
}
