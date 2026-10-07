/**
 * 用户领域类型与规则。
 *
 * 关键约束：`UserRecord` 含密码哈希，只允许仓储层与账号服务内部流转；
 * 任何对外（HTTP 响应、日志）都必须走 `toPublicUser` 投影，避免哈希外泄。
 */

export const PLATFORM_ROLES = ["admin", "user"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const USER_STATUSES = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** 内部记录：含密码哈希，禁止直接返回给调用方。 */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly role: PlatformRole;
  readonly status: UserStatus;
  /** epoch 毫秒。 */
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 对外用户视图：不含任何凭据材料。 */
export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: PlatformRole;
  readonly status: UserStatus;
  readonly createdAt: number;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === "string" && (PLATFORM_ROLES as readonly string[]).includes(value);
}

/**
 * 邮箱规范化：去空格 + 转小写。唯一性判定与登录查找都用规范化后的值，
 * 否则 Foo@x.com 与 foo@x.com 会被当成两个账号。
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 邮箱格式校验。刻意保持宽松（大致 RFC 5322 的常见子集）：
 * 真正的可达性只能靠投递验证，这里只拦明显非法的输入。
 */
export function validateEmail(email: string): string | null {
  if (!email) {
    return "邮箱不能为空";
  }
  if (email.length > 254) {
    return "邮箱过长";
  }
  const match = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.exec(email);
  if (!match) {
    return "邮箱格式不正确";
  }
  return null;
}

/** 未指定显示名时取邮箱 @ 前的部分，保证界面永远有可展示的称呼。 */
export function deriveDisplayName(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
