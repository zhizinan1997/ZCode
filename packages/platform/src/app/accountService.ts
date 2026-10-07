/**
 * 账号用例。所有登录态相关的写操作都收敛在这里，HTTP 与 CLI 只是它的调用方。
 *
 * 枚举防护：登录失败一律返回 invalid_credentials，且邮箱不存在时也要走一次真实的
 * scrypt 校验，避免通过响应耗时区分"账号不存在"与"密码错误"。
 */
import { PlatformError } from "../domain/errors.js";
import type { PlatformRole, UserRecord, UserStatus } from "../domain/user.js";
import { deriveDisplayName, normalizeEmail, validateEmail } from "../domain/user.js";
import { validatePasswordStrength } from "../domain/passwordPolicy.js";
import { isSessionUsable, type SessionRecord } from "../domain/session.js";
import type {
  AccountServiceDependencies,
  AuthenticatedContext,
  CreateUserInput,
  LoginInput,
  LoginResult,
  SetUserStatusInput,
  UserListPage,
} from "./ports.js";

/** 固定假哈希：格式合法、salt 随机，仅用于让"账号不存在"也付出同等校验成本。 */
const ABSENT_ACCOUNT_HASH =
  "scrypt$16384$8$1$6EgSyKDYDfgAi5iq3Kp01Q==$CTAWDZPFPj716gSa0yOqwtrXFbngn+8e92Y/PVp4jXvnWS7eQshN3xo5R/Q0npQql2qMmQEWSgReOKAep6k+Ow==";

export interface AccountService {
  createUser(input: CreateUserInput): Promise<UserRecord>;
  getUser(userId: string): Promise<UserRecord>;
  listUsers(options: { limit: number; offset: number }): Promise<UserListPage>;
  countUsers(): Promise<number>;
  /** 是否已存在管理员；用于首个管理员的引导判定。 */
  hasAdmin(): Promise<boolean>;
  setUserStatus(input: SetUserStatusInput): Promise<UserRecord>;
  setUserRole(userId: string, role: PlatformRole): Promise<UserRecord>;
  resetPassword(userId: string, newPassword: string): Promise<void>;
  changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    keepSessionId: string;
  }): Promise<void>;
  login(input: LoginInput): Promise<LoginResult>;
  logout(sessionId: string): Promise<void>;
  authenticate(token: string): Promise<AuthenticatedContext>;
}

export interface AccountServiceOptions extends AccountServiceDependencies {
  /** 校验并解析令牌；失败抛 PlatformError。 */
  readonly verifyToken: (token: string) => {
    sub: string;
    role: string;
    sid: string;
    iat: number;
    exp: number;
  };
}

function invalidCredentials(): PlatformError {
  return new PlatformError("invalid_credentials", "邮箱或密码不正确");
}

export function createAccountService(options: AccountServiceOptions): AccountService {
  const { users, sessions, now } = options;

  async function requireUser(userId: string): Promise<UserRecord> {
    const user = await users.findById(userId);
    if (!user) {
      throw new PlatformError("user_not_found", "用户不存在");
    }
    return user;
  }

  return {
    async createUser(input) {
      const email = normalizeEmail(input.email);
      const emailError = validateEmail(email);
      if (emailError) {
        throw new PlatformError("invalid_request", emailError);
      }
      const passwordError = validatePasswordStrength(input.password);
      if (passwordError) {
        throw new PlatformError("invalid_request", passwordError);
      }
      if (await users.findByEmail(email)) {
        throw new PlatformError("user_exists", "该邮箱已存在");
      }
      const timestamp = now();
      const user: UserRecord = {
        id: options.newUserId(),
        email,
        displayName: input.displayName?.trim() || deriveDisplayName(email),
        passwordHash: await options.hashPassword(input.password),
        role: input.role ?? "user",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await users.insert(user);
      return user;
    },

    async getUser(userId) {
      return await requireUser(userId);
    },

    async listUsers({ limit, offset }) {
      const [pageUsers, total] = await Promise.all([
        users.list({ limit, offset }),
        users.count(),
      ]);
      return { users: pageUsers, total };
    },

    async countUsers() {
      return await users.count();
    },

    async hasAdmin() {
      return await users.existsWithRole("admin");
    },

    async setUserStatus({ userId, status }) {
      const user = await requireUser(userId);
      if (user.status === status) {
        return user;
      }
      const updated: UserRecord = { ...user, status, updatedAt: now() };
      await users.update(updated);
      if (status === "disabled") {
        // 停用必须立刻生效：撤销全部会话，否则已登录客户端能继续用到令牌过期。
        await sessions.revokeAllForUser(userId, now());
      }
      return updated;
    },

    async setUserRole(userId, role) {
      const user = await requireUser(userId);
      if (user.role === role) {
        return user;
      }
      const updated: UserRecord = { ...user, role, updatedAt: now() };
      await users.update(updated);
      return updated;
    },

    async resetPassword(userId, newPassword) {
      const user = await requireUser(userId);
      const passwordError = validatePasswordStrength(newPassword);
      if (passwordError) {
        throw new PlatformError("invalid_request", passwordError);
      }
      await users.update({
        ...user,
        passwordHash: await options.hashPassword(newPassword),
        updatedAt: now(),
      });
      // 管理员重置密码属于敏感操作：强制该用户全部会话重新登录。
      await sessions.revokeAllForUser(userId, now());
    },

    async changePassword({ userId, currentPassword, newPassword, keepSessionId }) {
      const user = await requireUser(userId);
      if (!(await options.verifyPassword(currentPassword, user.passwordHash))) {
        throw invalidCredentials();
      }
      const passwordError = validatePasswordStrength(newPassword);
      if (passwordError) {
        throw new PlatformError("invalid_request", passwordError);
      }
      await users.update({
        ...user,
        passwordHash: await options.hashPassword(newPassword),
        updatedAt: now(),
      });
      // 改密后踢掉其它设备，但保留当前会话，避免用户改完密码立刻被登出。
      await sessions.revokeAllForUserExcept(userId, keepSessionId, now());
    },

    async login({ email, password, userAgent }) {
      const normalized = normalizeEmail(email);
      const user = await users.findByEmail(normalized);
      if (!user) {
        // 不存在也要做一次等价代价的校验，避免用响应时间探测账号是否存在。
        await options.verifyPassword(password, ABSENT_ACCOUNT_HASH);
        throw invalidCredentials();
      }
      if (!(await options.verifyPassword(password, user.passwordHash))) {
        throw invalidCredentials();
      }
      if (user.status !== "active") {
        throw invalidCredentials();
      }
      const issuedAt = now();
      const expiresAt = issuedAt + options.sessionTtlMs;
      const session: SessionRecord = {
        id: options.newSessionId(),
        userId: user.id,
        createdAt: issuedAt,
        expiresAt,
        revokedAt: null,
        userAgent: userAgent?.trim() || null,
      };
      await sessions.insert(session);
      const token = options.signToken({
        sub: user.id,
        role: user.role,
        sid: session.id,
        iat: Math.floor(issuedAt / 1000),
        exp: Math.floor(expiresAt / 1000),
      });
      return { token, expiresAt, user };
    },

    async logout(sessionId) {
      await sessions.revoke(sessionId, now());
    },

    async authenticate(token) {
      const claims = options.verifyToken(token);
      const user = await users.findById(claims.sub);
      if (!user) {
        throw new PlatformError("unauthorized", "令牌对应的用户不存在");
      }
      const session = await sessions.findById(claims.sid);
      if (!session || session.userId !== user.id) {
        throw new PlatformError("session_revoked", "会话已失效");
      }
      if (!isSessionUsable(session, now())) {
        throw new PlatformError("session_revoked", "会话已失效");
      }
      if (user.status !== "active") {
        throw new PlatformError("user_disabled", "账号已停用");
      }
      return { user, session };
    },
  };
}

/** 管理员权限判定；用于所有 /api/admin 路由。 */
export function requireAdmin(context: AuthenticatedContext): void {
  if (context.user.role !== "admin") {
    throw new PlatformError("forbidden", "需要管理员权限");
  }
}

export type { UserStatus };
