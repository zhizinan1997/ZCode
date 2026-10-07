/**
 * 管理接口：用户套餐订阅的发放、撤销与查询。
 *
 * 从 adminUsers.ts 拆出（架构 max-lines 约束）：订阅是与"账号本身"正交的
 * 运营动作，独立成文件也让发放/撤销的事务语义更好读。
 * 审计动作：user.grant_plan / user.revoke_plan。
 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { OperationsService } from "../../../app/operationsService.js";
import type { PlanService } from "../../../app/planService.js";
import { readJsonObject, readString } from "../helpers.js";
import { createAdminGuard, type AdminResolver } from "./adminSupport.js";

export function createAdminUserSubscriptionRoutes(deps: {
  readonly accounts: AccountService;
  readonly operations: OperationsService;
  readonly plans: PlanService;
}): Hono {
  const routes = new Hono();
  const requireAdmin: AdminResolver = createAdminGuard(deps.accounts);

  /** 与 adminUsers 相同的审计旁路：record 内部吞异常。 */
  const audit = (
    admin: { user: { id: string } },
    action: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown> | null,
  ): void => {
    deps.operations.record({
      actorUserId: admin.user.id,
      action,
      targetType,
      targetId,
      detail: detail ? JSON.stringify(detail) : null,
      now: Date.now(),
    });
  };

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
    audit(admin, "user.grant_plan", "user", userId, { planId });
    return context.json({ subscription }, 201);
  });

  routes.delete("/users/:id/subscription", async (context) => {
    const admin = await requireAdmin(context);
    const userId = context.req.param("id");
    await deps.accounts.getUser(userId);
    await deps.plans.revokeSubscriptions(userId);
    audit(admin, "user.revoke_plan", "user", userId, null);
    return context.body(null, 204);
  });

  routes.get("/users/:id/subscriptions", async (context) => {
    await requireAdmin(context);
    const subscriptions = await deps.plans.listSubscriptions(context.req.param("id"));
    return context.json({ subscriptions });
  });

  return routes;
}
