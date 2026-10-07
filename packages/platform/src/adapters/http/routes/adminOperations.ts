/**
 * 管理接口：系统设置、审计日志、兑换码、用户 API Key、公开兑换入口。
 *
 * 语义与事务边界见 specs/platform/operations.md。所有写操作都通过
 * operations.record() 留审计痕迹；审计失败不影响业务结果。
 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { OperationsService } from "../../../app/operationsService.js";
import { PlatformError } from "../../../domain/errors.js";
import { formatMicros } from "../../../domain/money.js";
import { readJsonObject, readString, requireAuth } from "../helpers.js";
import { createAdminGuard, readPagination, type AdminResolver } from "./adminSupport.js";

function parsePositiveInt(raw: string | undefined, label: string, max: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new PlatformError("invalid_request", `${label} 必须是 1..${max} 的整数`);
  }
  return value;
}

export function createAdminOperationRoutes(deps: {
  readonly accounts: AccountService;
  readonly operations: OperationsService;
}): Hono {
  const routes = new Hono();
  const requireAdmin: AdminResolver = createAdminGuard(deps.accounts);

  // ── 系统设置 ─────────────────────────────────────────────
  routes.get("/settings", async (context) => {
    await requireAdmin(context);
    return context.json({ settings: await deps.operations.getSettings() });
  });

  routes.put("/settings", async (context) => {
    const admin = await requireAdmin(context);
    const body = await readJsonObject(context);
    const allowRaw = body["allowSelfRegistration"];
    if (allowRaw !== undefined && typeof allowRaw !== "boolean") {
      throw new PlatformError("invalid_request", "allowSelfRegistration 必须是布尔值");
    }
    const settings = await deps.operations.updateSettings({
      ...(body["forceUpdateMinimalVersion"] !== undefined
        ? {
            forceUpdateMinimalVersion: readString(body, "forceUpdateMinimalVersion", {
              maxLength: 40,
            }),
          }
        : {}),
      ...(allowRaw !== undefined ? { allowSelfRegistration: allowRaw as boolean } : {}),
      updatedBy: admin.user.id,
    });
    return context.json({ settings });
  });

  // ── 审计日志 ─────────────────────────────────────────────
  routes.get("/audit", async (context) => {
    await requireAdmin(context);
    const { limit, offset } = readPagination(context, { defaultLimit: 100 });
    const action = context.req.query("action")?.trim() || undefined;
    const actor = context.req.query("actor")?.trim() || undefined;
    const result = await deps.operations.listAudit({
      ...(action ? { action } : {}),
      ...(actor ? { actor } : {}),
      limit,
      offset,
    });
    return context.json({ entries: result.entries, total: result.total, limit, offset });
  });

  // ── 兑换码 ───────────────────────────────────────────────
  routes.get("/redeem-codes", async (context) => {
    await requireAdmin(context);
    const codes = await deps.operations.listRedeemCodes();
    return context.json({
      codes: codes.map((code) => ({
        ...code,
        // redeemedCount 在核销事务里与 redemption 插入同事务递增，是权威的已核销次数。
        redemptionCount: code.redeemedCount,
        amount: formatMicros(code.amountMicros),
      })),
    });
  });

  routes.post("/redeem-codes", async (context) => {
    const admin = await requireAdmin(context);
    const body = await readJsonObject(context);
    const count = parsePositiveInt(String(body["count"] ?? "1"), "生成数量", 50);
    const expiresRaw = readString(body, "expiresAt", { maxLength: 40 });
    const expiresAt = expiresRaw.trim() ? Number(expiresRaw) : null;
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())) {
      throw new PlatformError("invalid_request", "过期时间必须是未来的时间戳");
    }
    const created = await deps.operations.createRedeemCodes({
      count,
      amount: readString(body, "amount", { required: true, maxLength: 32, label: "面额" }),
      maxRedemptions: parsePositiveInt(String(body["maxRedemptions"] ?? "1"), "核销次数", 10_000),
      expiresAt,
      createdBy: admin.user.id,
    });
    return context.json(
      { codes: created.map((code) => ({ ...code, amount: formatMicros(code.amountMicros) })) },
      201,
    );
  });

  routes.delete("/redeem-codes/:id", async (context) => {
    const admin = await requireAdmin(context);
    await deps.operations.revokeRedeemCode({
      codeId: context.req.param("id"),
      actorUserId: admin.user.id,
    });
    return context.body(null, 204);
  });

  // ── 用户 API Key（全站视角）─────────────────────────────
  routes.get("/api-keys", async (context) => {
    await requireAdmin(context);
    const keys = await deps.operations.listAllApiKeys();
    // 永远不回 keyHash；hint 已在记录里。
    return context.json({
      keys: keys.map(({ keyHash: _keyHash, ...rest }) => rest),
    });
  });

  routes.post("/api-keys", async (context) => {
    const admin = await requireAdmin(context);
    const body = await readJsonObject(context);
    const result = await deps.operations.createApiKey({
      userId: readString(body, "userId", { required: true, maxLength: 100, label: "用户" }),
      name: readString(body, "name", { maxLength: 100 }),
      actorUserId: admin.user.id,
    });
    // 明文只在这一次响应里出现。
    return context.json({ key: result.record, plaintext: result.plaintext }, 201);
  });

  routes.delete("/api-keys/:id", async (context) => {
    const admin = await requireAdmin(context);
    await deps.operations.revokeApiKey({
      keyId: context.req.param("id"),
      actorUserId: admin.user.id,
    });
    return context.body(null, 204);
  });

  return routes;
}

/** 用户自助接口：核销兑换码、管理自己的 API Key。挂在 /api/v1 下。 */
export function createPublicOperationRoutes(deps: {
  readonly accounts: AccountService;
  readonly operations: OperationsService;
}): Hono {
  const routes = new Hono();

  routes.post("/redeem", async (context) => {
    const session = await requireAuth(context, deps.accounts);
    const body = await readJsonObject(context);
    const result = await deps.operations.redeemCode({
      userId: session.user.id,
      code: readString(body, "code", { required: true, maxLength: 40, label: "兑换码" }),
    });
    return context.json({
      amountMicros: result.amountMicros,
      amount: formatMicros(result.amountMicros),
    });
  });

  routes.get("/api-keys", async (context) => {
    const session = await requireAuth(context, deps.accounts);
    const keys = await deps.operations.listApiKeysForUser(session.user.id);
    return context.json({ keys: keys.map(({ keyHash: _keyHash, ...rest }) => rest) });
  });

  routes.post("/api-keys", async (context) => {
    const session = await requireAuth(context, deps.accounts);
    const body = await readJsonObject(context);
    const result = await deps.operations.createApiKey({
      userId: session.user.id,
      name: readString(body, "name", { maxLength: 100 }),
      actorUserId: session.user.id,
    });
    return context.json({ key: result.record, plaintext: result.plaintext }, 201);
  });

  routes.delete("/api-keys/:id", async (context) => {
    const session = await requireAuth(context, deps.accounts);
    const keyId = context.req.param("id");
    const keys = await deps.operations.listApiKeysForUser(session.user.id);
    if (!keys.some((key) => key.id === keyId)) {
      throw new PlatformError("not_found", "API Key 不存在或不属于你");
    }
    await deps.operations.revokeApiKey({ keyId, actorUserId: session.user.id });
    return context.body(null, 204);
  });

  return routes;
}
