/** /api/auth/*：登录、登出、当前用户、改密。 */
import { Hono, type Context } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import { PlatformError } from "../../../domain/errors.js";
import { normalizeEmail, toPublicUser } from "../../../domain/user.js";
import { readJsonObject, readString, requireAuth } from "../helpers.js";

/**
 * 登录限流参数（审计#10）：管理员密码原本可以被无限次爆破。
 * - 滑动窗口 15 分钟，键为 IP + 归一化邮箱；
 * - 窗口内第 5 次失败起锁定，锁定时长 = min(2^(n-5) 秒, 15 分钟)，n 为窗口内失败次数；
 * - 锁定期间直接 429，不校验凭据；登录成功清零。
 * 记录放进程内存，进程重启清零（可接受）。
 */
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_THRESHOLD = 5;
const LOGIN_LOCK_BASE_MS = 1000;
const LOGIN_LOCK_MAX_MS = 15 * 60 * 1000;
/** 失败记录的条目上限：防止用海量邮箱/IP 组合撑爆内存。 */
const LOGIN_STATE_MAX_ENTRIES = 10_000;

interface LoginFailureState {
  /** 窗口内的失败时间戳（epoch 毫秒）。 */
  failures: number[];
  /** 锁定截止时间；0 表示未锁定。 */
  lockedUntil: number;
}

const loginFailures = new Map<string, LoginFailureState>();

/** 请求来源 IP：反向代理部署时以代理写入的 X-Forwarded-For 为准（直连时该头可伪造，但服务默认只监听回环）。 */
function clientIp(context: Context): string {
  const forwarded = context.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) {
    return forwarded;
  }
  const realIp = context.req.header("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }
  const incoming = (
    context.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  )?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

function pruneFailures(state: LoginFailureState, now: number): void {
  state.failures = state.failures.filter((timestamp) => now - timestamp < LOGIN_FAILURE_WINDOW_MS);
}

function pruneStaleEntries(now: number): void {
  for (const [key, state] of loginFailures) {
    pruneFailures(state, now);
    if (state.failures.length === 0 && state.lockedUntil <= now) {
      loginFailures.delete(key);
    }
  }
}

/** 剩余锁定毫秒数；未锁定时为 0。 */
function lockRemainingMs(key: string, now: number): number {
  const state = loginFailures.get(key);
  if (!state) {
    return 0;
  }
  pruneFailures(state, now);
  return state.lockedUntil > now ? state.lockedUntil - now : 0;
}

function recordLoginFailure(key: string, now: number): void {
  if (loginFailures.size >= LOGIN_STATE_MAX_ENTRIES) {
    pruneStaleEntries(now);
  }
  const state = loginFailures.get(key) ?? { failures: [], lockedUntil: 0 };
  pruneFailures(state, now);
  state.failures.push(now);
  const overThreshold = state.failures.length - LOGIN_FAILURE_THRESHOLD;
  if (overThreshold >= 0) {
    // 2^n 秒递增：第 5 次锁 1 秒、第 6 次 2 秒、第 7 次 4 秒……上限 15 分钟。
    const lockMs = Math.min(LOGIN_LOCK_BASE_MS * 2 ** overThreshold, LOGIN_LOCK_MAX_MS);
    state.lockedUntil = now + lockMs;
  }
  loginFailures.set(key, state);
}

function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}

export function createAuthRoutes(accounts: AccountService): Hono {
  const routes = new Hono();

  routes.post("/login", async (context) => {
    const body = await readJsonObject(context);
    const email = readString(body, "email", { required: true, maxLength: 254 });
    const password = readString(body, "password", { required: true, maxLength: 200 });
    const throttleKey = `${clientIp(context)}|${normalizeEmail(email)}`;
    const attemptAt = Date.now();
    const retryAfterMs = lockRemainingMs(throttleKey, attemptAt);
    if (retryAfterMs > 0) {
      // 审计#10：锁定期间不校验凭据——否则爆破者仍能借响应差异试探密码。
      const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
      context.header("retry-after", String(retryAfterSeconds));
      return context.json(
        {
          error: {
            code: "too_many_requests",
            message: `登录尝试过于频繁，请 ${retryAfterSeconds} 秒后再试`,
          },
        },
        429,
      );
    }
    const result = await accounts
      .login({
        email,
        password,
        userAgent: context.req.header("user-agent"),
      })
      .catch((error: unknown) => {
        // 只统计凭据失败；请求体非法（400）不计入，避免畸形请求刷锁。
        if (error instanceof PlatformError && error.code === "invalid_credentials") {
          recordLoginFailure(throttleKey, Date.now());
        }
        throw error;
      });
    clearLoginFailures(throttleKey);
    return context.json({
      token: result.token,
      expiresAt: result.expiresAt,
      user: toPublicUser(result.user),
    });
  });

  routes.post("/logout", async (context) => {
    const session = await requireAuth(context, accounts);
    await accounts.logout(session.session.id);
    return context.body(null, 204);
  });

  routes.get("/me", async (context) => {
    const session = await requireAuth(context, accounts);
    return context.json({
      user: toPublicUser(session.user),
      expiresAt: session.session.expiresAt,
    });
  });

  routes.post("/password", async (context) => {
    const session = await requireAuth(context, accounts);
    const body = await readJsonObject(context);
    const currentPassword = readString(body, "currentPassword", {
      required: true,
      maxLength: 200,
      label: "当前密码",
    });
    const newPassword = readString(body, "newPassword", {
      required: true,
      maxLength: 200,
      label: "新密码",
    });
    await accounts.changePassword({
      userId: session.user.id,
      currentPassword,
      newPassword,
      keepSessionId: session.session.id,
    });
    return context.body(null, 204);
  });

  return routes;
}
