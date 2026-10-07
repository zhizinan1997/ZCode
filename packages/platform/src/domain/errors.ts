/**
 * 平台错误：错误码是跨进程契约（客户端与运维都要识别），因此集中定义并绑定 HTTP 状态。
 * 面向用户的失败语义固定：账号相关失败一律 invalid_credentials，不区分邮箱不存在与密码错误。
 */
export const PLATFORM_ERROR_CODES = [
  "invalid_request",
  "invalid_credentials",
  "unauthorized",
  "forbidden",
  "user_exists",
  "user_not_found",
  "user_disabled",
  "insufficient_balance",
  "model_not_entitled",
  "model_not_priced",
  "path_not_allowed",
  "too_many_requests",
  "payload_too_large",
  "session_revoked",
  "conflict",
  "not_found",
  "internal_error",
] as const;

export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<PlatformErrorCode, number> = {
  invalid_request: 400,
  invalid_credentials: 401,
  unauthorized: 401,
  forbidden: 403,
  user_exists: 409,
  user_not_found: 404,
  user_disabled: 403,
  insufficient_balance: 402,
  model_not_entitled: 403,
  model_not_priced: 403,
  path_not_allowed: 404,
  too_many_requests: 429,
  payload_too_large: 413,
  session_revoked: 401,
  conflict: 409,
  not_found: 404,
  internal_error: 500,
};

export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly status: number;
  /** 附加信息只用于服务端日志，不返回给客户端，避免泄露账号是否存在等事实。 */
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: PlatformErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PlatformError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
  }
}

export function isPlatformError(value: unknown): value is PlatformError {
  return value instanceof PlatformError;
}

/** 供 HTTP 边界转换未知异常；已知错误原样返回。 */
export function toPlatformError(value: unknown): PlatformError {
  if (isPlatformError(value)) {
    return value;
  }
  return new PlatformError("internal_error", "平台内部错误", { cause: value });
}
