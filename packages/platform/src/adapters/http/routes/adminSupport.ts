/** 管理接口共用的鉴权与输入解析。 */
import type { Context } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import { requireAdmin } from "../../../app/accountService.js";
import type { AuthenticatedContext } from "../../../app/ports.js";
import { PlatformError } from "../../../domain/errors.js";
import { readJsonObject, readString, requireAuth } from "../helpers.js";

export type AdminResolver = (context: Context) => Promise<AuthenticatedContext>;

export function createAdminGuard(accounts: AccountService): AdminResolver {
  return async (context) => {
    const session = await requireAuth(context, accounts);
    requireAdmin(session);
    return session;
  };
}

/** 分页参数；管理后台的列表默认一页 50 条。 */
export function readPagination(
  context: Context,
  options: { defaultLimit?: number; maxLimit?: number } = {},
): { limit: number; offset: number } {
  const defaultLimit = options.defaultLimit ?? 50;
  const maxLimit = options.maxLimit ?? 200;
  const rawLimit = context.req.query("limit");
  const rawOffset = context.req.query("offset");
  const limit = rawLimit === undefined ? defaultLimit : Number(rawLimit);
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new PlatformError("invalid_request", `limit 必须是 1..${maxLimit} 的整数`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new PlatformError("invalid_request", "offset 必须是非负整数");
  }
  return { limit, offset };
}

/** 读取 "最近 N 天" 过滤条件，转成 since 时间戳。 */
export function readSinceDays(
  context: Context,
  options: { defaultDays?: number; maxDays?: number } = {},
): number | undefined {
  const raw = context.req.query("sinceDays");
  if (raw === undefined) {
    const defaultDays = options.defaultDays;
    if (defaultDays === undefined) {
      return undefined;
    }
    return Date.now() - defaultDays * 24 * 60 * 60 * 1000;
  }
  const days = Number(raw);
  const maxDays = options.maxDays ?? 3650;
  if (!Number.isSafeInteger(days) || days <= 0 || days > maxDays) {
    throw new PlatformError("invalid_request", `sinceDays 必须是 1..${maxDays} 的整数`);
  }
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

export async function readOptionalJsonObject(
  context: Context,
): Promise<Record<string, unknown>> {
  return await readJsonObject(context);
}

export { readString };
