/** HTTP 边界辅助：请求体解析与登录态提取。所有输入校验失败都抛 invalid_request。 */
import type { Context } from "hono";
import type { AccountService } from "../../app/accountService.js";
import type { AuthenticatedContext } from "../../app/ports.js";
import { PlatformError } from "../../domain/errors.js";
import { readBearerToken } from "../../domain/token.js";

export async function readJsonObject(context: Context): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await context.req.json();
  } catch {
    throw new PlatformError("invalid_request", "请求体不是合法 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PlatformError("invalid_request", "请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

export function readString(
  body: Record<string, unknown>,
  field: string,
  options: { required?: boolean; maxLength?: number; label?: string } = {},
): string {
  const label = options.label ?? field;
  const raw = body[field];
  if (raw === undefined || raw === null) {
    if (options.required) {
      throw new PlatformError("invalid_request", `缺少字段 ${field}`);
    }
    return "";
  }
  if (typeof raw !== "string") {
    throw new PlatformError("invalid_request", `${label}必须是字符串`);
  }
  if (options.required && !raw.trim()) {
    throw new PlatformError("invalid_request", `${label}不能为空`);
  }
  if (options.maxLength !== undefined && raw.length > options.maxLength) {
    throw new PlatformError("invalid_request", `${label}过长`);
  }
  return raw;
}

export function readEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const raw = body[field];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new PlatformError("invalid_request", `${field} 取值非法，允许：${allowed.join(", ")}`);
  }
  return raw as T;
}

/** 可选布尔字段：缺省取 default，出现时必须是布尔值。 */
export function readBoolean(
  body: Record<string, unknown>,
  field: string,
  options: { default: boolean },
): boolean {
  const raw = body[field];
  if (raw === undefined || raw === null) {
    return options.default;
  }
  if (typeof raw !== "boolean") {
    throw new PlatformError("invalid_request", `${field} 必须是布尔值`);
  }
  return raw;
}

export function readPagination(context: Context): { limit: number; offset: number } {
  const rawLimit = context.req.query("limit");
  const rawOffset = context.req.query("offset");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new PlatformError("invalid_request", "limit 必须是 1..200 的整数");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new PlatformError("invalid_request", "offset 必须是非负整数");
  }
  return { limit, offset };
}

/** 从 Authorization 头取令牌并完成登录态校验；失败抛 unauthorized。 */
export async function requireAuth(
  context: Context,
  accounts: AccountService,
): Promise<AuthenticatedContext> {
  const authorization = context.req.header("authorization");
  const token = readBearerToken(authorization);
  if (!token) {
    throw new PlatformError("unauthorized", "缺少访问令牌");
  }
  return await accounts.authenticate(token);
}
