/** 管理接口：套餐定义。 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { PlanService } from "../../../app/planService.js";
import { PlatformError } from "../../../domain/errors.js";
import { formatMicros, microsFromDecimalString, type Micros } from "../../../domain/money.js";
import { readJsonObject, readString } from "../helpers.js";
import { createAdminGuard } from "./adminSupport.js";

function parseQuota(raw: string): Micros {
  try {
    return microsFromDecimalString(raw);
  } catch (error) {
    throw new PlatformError("invalid_request", `套餐额度格式不正确：${raw}`, { cause: error });
  }
}

function readAllowedModels(body: Record<string, unknown>): string[] | undefined {
  const raw = body["allowedModels"];
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new PlatformError("invalid_request", "allowedModels 必须是字符串数组");
  }
  return raw.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new PlatformError("invalid_request", "allowedModels 只能是模型 id 字符串");
    }
    return item.trim();
  });
}

function readDurationDays(body: Record<string, unknown>): number | null | undefined {
  const raw = body["durationDays"];
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null || raw === "") {
    return null;
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PlatformError("invalid_request", "durationDays 必须是正整数，或留空表示长期有效");
  }
  return parsed;
}

function toView(plan: {
  id: string;
  name: string;
  quotaMicros: Micros;
  durationDays: number | null;
  allowedModels: readonly string[];
}) {
  return {
    id: plan.id,
    name: plan.name,
    quotaMicros: plan.quotaMicros,
    quota: formatMicros(plan.quotaMicros),
    durationDays: plan.durationDays,
    allowedModels: plan.allowedModels,
  };
}

export function createAdminPlanRoutes(deps: {
  readonly accounts: AccountService;
  readonly plans: PlanService;
}): Hono {
  const routes = new Hono();
  const requireAdmin = createAdminGuard(deps.accounts);

  routes.get("/plans", async (context) => {
    await requireAdmin(context);
    const plans = await deps.plans.listPlans();
    return context.json({ plans: plans.map(toView) });
  });

  routes.post("/plans", async (context) => {
    await requireAdmin(context);
    const body = await readJsonObject(context);
    const plan = await deps.plans.createPlan({
      name: readString(body, "name", { required: true, maxLength: 100 }),
      quotaMicros: parseQuota(
        readString(body, "quota", { required: true, maxLength: 32, label: "套餐额度" }),
      ),
      durationDays: readDurationDays(body) ?? null,
      allowedModels: readAllowedModels(body) ?? [],
    });
    return context.json({ plan: toView(plan) }, 201);
  });

  routes.patch("/plans/:id", async (context) => {
    await requireAdmin(context);
    const body = await readJsonObject(context);
    const quotaRaw = readString(body, "quota", { maxLength: 32 });
    const plan = await deps.plans.updatePlan({
      planId: context.req.param("id"),
      ...(body["name"] !== undefined
        ? { name: readString(body, "name", { required: true, maxLength: 100 }) }
        : {}),
      ...(quotaRaw.trim() ? { quotaMicros: parseQuota(quotaRaw) } : {}),
      ...(readDurationDays(body) !== undefined
        ? { durationDays: readDurationDays(body) ?? null }
        : {}),
      ...(readAllowedModels(body) !== undefined
        ? { allowedModels: readAllowedModels(body) ?? [] }
        : {}),
    });
    return context.json({ plan: toView(plan) });
  });

  routes.delete("/plans/:id", async (context) => {
    await requireAdmin(context);
    await deps.plans.deletePlan(context.req.param("id"));
    return context.body(null, 204);
  });

  return routes;
}
