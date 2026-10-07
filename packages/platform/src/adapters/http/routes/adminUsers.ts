/**
 * 管理接口：用户、余额、流水、套餐发放。
 *
 * 金额一律以十进制字符串进出（如 "12.5"），由服务端转成整数微元：
 * 让管理员在表单里直接写货币单位，同时避免浮点进入记账链路。
 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { BillingService } from "../../../app/billingService.js";
import type { OperationsService } from "../../../app/operationsService.js";
import type { PlanService } from "../../../app/planService.js";
import type { AuthenticatedContext } from "../../../app/ports.js";
import { PlatformError } from "../../../domain/errors.js";
import { formatMicros, type Micros } from "../../../domain/money.js";
import {
  PLATFORM_ROLES,
  USER_STATUSES,
  toPublicUser,
  type PlatformRole,
  type UserRecord,
  type UserStatus,
} from "../../../domain/user.js";
import { readEnum, readJsonObject, readString } from "../helpers.js";
import { createAdminGuard, readPagination, type AdminResolver } from "./adminSupport.js";

/** 单页摘要并发的上限：本地 SQLite 单文件库，串行会白白放大列表页延迟。 */
const SUMMARIZE_CONCURRENCY = 8;
/** bulk-subscription 单次最多处理的用户数，防止一次请求把数据库写队列占满。 */
const MAX_BULK_USERS = 500;

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

/**
 * 审计#11：管理员账号自我保护，防止把系统改成"没有启用管理员"的状态。
 * - 不允许管理员停用或降级自己（防误操作把自己锁在系统外）；
 * - 不允许任何操作移除最后一个启用（active）的管理员（纵深防御，挡住并发交错）。
 * 生效值与当前值相同（无实际变化）时直接放行。
 */
export function assertAdminPatchAllowed(input: {
  readonly actorUserId: string;
  readonly target: UserRecord;
  readonly nextRole: PlatformRole;
  readonly nextStatus: UserStatus;
  /** 当前启用管理员数量；调用方只在可能移除启用管理员时才查询，其他情况传 0。 */
  readonly activeAdminCount: number;
}): void {
  const { target, nextRole, nextStatus, activeAdminCount } = input;
  const removesActiveAdmin =
    target.role === "admin" &&
    target.status === "active" &&
    (nextRole !== "admin" || nextStatus !== "active");
  if (!removesActiveAdmin) {
    return;
  }
  if (target.id === input.actorUserId) {
    throw new PlatformError(
      "forbidden",
      nextStatus !== "active" ? "不能停用自己的账号" : "不能降低自己的角色",
    );
  }
  if (activeAdminCount <= 1) {
    throw new PlatformError("conflict", "系统必须保留至少一个启用的管理员，该操作会移除最后一个");
  }
}

/**
 * 有界并发地映射列表：逐个 await 会串行放大延迟，无界 Promise.all 又会让
 * 上百个查询同时压到 SQLite 连接上。这里固定同时跑 limit 个任务。
 *
 * 没有改用"一条 SQL 批量取余额"：getSummary 还要联合套餐与订阅，而给
 * BillingRepository 加批量方法需要同时动 billingRepo.ts（本次范围外）。
 * 本地 SQLite 单文件场景下 8 路并发 200 用户在百毫秒内，是可接受的折衷。
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createAdminUserRoutes(deps: {
  readonly accounts: AccountService;
  readonly billing: BillingService;
  readonly operations: OperationsService;
  readonly plans: PlanService;
}): Hono {
  const routes = new Hono();
  const requireAdmin: AdminResolver = createAdminGuard(deps.accounts);

  /** 统一审计旁路：record 内部吞异常，这里只负责统一字段与 JSON 序列化。 */
  const audit = (
    admin: AuthenticatedContext,
    action: string,
    targetType: "user" | "plan",
    targetId: string,
    detail: Record<string, unknown> | null,
  ): void => {
    deps.operations.record({
      actorUserId: admin.user.id,
      action,
      targetType,
      targetId,
      detail: detail === null ? null : JSON.stringify(detail),
      now: Date.now(),
    });
  };

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
    const q = context.req.query("q")?.trim() ?? "";
    // 搜索与总数并行取；两个分支最终都拿到 UserRecord[] 与 total。
    const [pageUsers, total] = await Promise.all([
      q
        ? deps.accounts.searchUsers({ q, limit, offset }).then((page) => page.users)
        : deps.accounts.listUsers({ limit, offset }).then((page) => page.users),
      q ? deps.accounts.countSearchUsers({ q }) : deps.accounts.countUsers(),
    ]);
    // 余额与套餐一起返回：管理后台的用户列表需要一眼看到"谁还有钱"。
    // 逐行让前端再查会产生 N+1 请求；这里在服务端用有界并发取摘要。
    const users = await mapWithConcurrency(pageUsers, SUMMARIZE_CONCURRENCY, summarize);
    return context.json({ ...(q ? { q } : {}), users, total, limit, offset });
  });

  routes.post("/users", async (context) => {
    const admin = await requireAdmin(context);
    const body = await readJsonObject(context);
    const created = await deps.accounts.createUser({
      email: readString(body, "email", { required: true, maxLength: 254 }),
      password: readString(body, "password", { required: true, maxLength: 200 }),
      displayName: readString(body, "displayName", { maxLength: 100 }) || undefined,
      role: readEnum(body, "role", PLATFORM_ROLES),
    });
    audit(admin, "user.create", "user", created.id, { email: created.email, role: created.role });
    return context.json({ user: await summarize(created) }, 201);
  });

  routes.post("/users/bulk-subscription", async (context) => {
    const admin = await requireAdmin(context);
    const body = await readJsonObject(context);
    const planId = readString(body, "planId", { required: true, maxLength: 200, label: "套餐" });
    const userIdsRaw = body["userIds"];
    if (!Array.isArray(userIdsRaw) || userIdsRaw.length < 1 || userIdsRaw.length > MAX_BULK_USERS) {
      throw new PlatformError(
        "invalid_request",
        `userIds 必须是 1..${MAX_BULK_USERS} 个用户 id 的数组`,
      );
    }
    const userIds = userIdsRaw.map((raw) => {
      if (typeof raw !== "string" || !raw.trim()) {
        throw new PlatformError("invalid_request", "userIds 里出现了空的用户 id");
      }
      return raw.trim();
    });
    const granted: string[] = [];
    const failed: { userId: string; error: string }[] = [];
    // 单个用户失败（套餐不存在、用户不存在等）不中断整体，逐个收集原因。
    for (const userId of userIds) {
      try {
        await deps.plans.grantSubscription({ userId, planId, createdBy: admin.user.id });
        granted.push(userId);
      } catch (error) {
        failed.push({
          userId,
          error: error instanceof PlatformError ? error.message : "发放失败，请稍后重试",
        });
      }
    }
    audit(admin, "user.grant_plan", "plan", planId, {
      granted: granted.length,
      failed: failed.length,
    });
    return context.json({ granted: granted.length, failed }, 200);
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
    const admin = await requireAdmin(context);
    const userId = context.req.param("id");
    const body = await readJsonObject(context);
    const role = readEnum(body, "role", PLATFORM_ROLES);
    const status = readEnum(body, "status", USER_STATUSES);
    const hasDisplayName = body["displayName"] !== undefined;
    const hasEmail = body["email"] !== undefined;
    if (role === undefined && status === undefined && !hasDisplayName && !hasEmail) {
      throw new PlatformError("invalid_request", "至少需要提供 displayName、email、role 或 status");
    }
    // 审计#11：先看生效后的值，再决定是否触碰数据库；无实际变化的请求按幂等放行。
    const target = await deps.accounts.getUser(userId);
    const nextRole = role ?? target.role;
    const nextStatus = status ?? target.status;
    const removesActiveAdmin =
      target.role === "admin" &&
      target.status === "active" &&
      (nextRole !== "admin" || nextStatus !== "active");
    // 只有在可能移除启用管理员时才查计数，普通用户改动不付额外查询成本。
    const activeAdminCount = removesActiveAdmin ? await deps.accounts.countActiveAdmins() : 0;
    assertAdminPatchAllowed({
      actorUserId: admin.user.id,
      target,
      nextRole,
      nextStatus,
      activeAdminCount,
    });
    const updated = await deps.accounts.updateUser({
      userId,
      ...(hasDisplayName
        ? { displayName: readString(body, "displayName", { maxLength: 100, label: "显示名" }) }
        : {}),
      ...(hasEmail ? { email: readString(body, "email", { maxLength: 254, label: "邮箱" }) } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    // 审计只记管理侧关心的字段，不落任何凭据类信息。
    audit(admin, "user.update", "user", userId, {
      displayName: hasDisplayName ? updated.displayName : undefined,
      email: hasEmail ? updated.email : undefined,
      role:
        role !== undefined && role !== target.role ? { from: target.role, to: role } : undefined,
      status:
        status !== undefined && status !== target.status
          ? { from: target.status, to: status }
          : undefined,
    });
    return context.json({ user: await summarize(updated) });
  });

  routes.delete("/users/:id", async (context) => {
    const admin = await requireAdmin(context);
    const userId = context.req.param("id");
    const target = await deps.accounts.getUser(userId);
    if (target.id === admin.user.id) {
      // 管理员不能删自己：删除即登出，误触后无法从审计里恢复操作者。
      throw new PlatformError("forbidden", "不能删除自己的账号");
    }
    if (target.role === "admin" && target.status === "active") {
      const activeAdminCount = await deps.accounts.countActiveAdmins();
      if (activeAdminCount <= 1) {
        throw new PlatformError(
          "conflict",
          "系统必须保留至少一个启用的管理员，该操作会移除最后一个",
        );
      }
    }
    await deps.accounts.deleteUser(userId);
    audit(admin, "user.delete", "user", userId, { email: target.email, role: target.role });
    return context.body(null, 204);
  });

  routes.post("/users/:id/password", async (context) => {
    const admin = await requireAdmin(context);
    const userId = context.req.param("id");
    const body = await readJsonObject(context);
    await deps.accounts.resetPassword(
      userId,
      readString(body, "newPassword", { required: true, maxLength: 200, label: "新密码" }),
    );
    audit(admin, "user.reset_password", "user", userId, null);
    return context.body(null, 204);
  });

  return routes;
}
