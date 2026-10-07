/**
 * 平台账号 provider。
 *
 * 与 zai / bigmodel 的本质区别：登录不是浏览器 OAuth 跳转，而是用户在客户端表单里
 * 提交邮箱密码，由 host 直接向平台后端换取会话令牌。因此它刻意**不实现**
 * `OAuthProviderAdapter`——那套接口里的 authorize / exchange / callback 在这里全是空壳，
 * 硬套只会让"哪些方法真的会被调用"变得不可读。
 *
 * 它仍在 provider 体系里的原因：复用既有的凭据命名空间（oauth:platform:*）与启动恢复链路。
 */
import {
  PLATFORM_PROVIDER_ID,
  resolveRuntimeZCodeEndpointOrigin,
  type OAuthProviderMeta,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";

const LOGIN_PATH = "/api/auth/login";
const ACCOUNT_PATH = "/api/auth/me";
const LOGIN_TIMEOUT_MS = 20_000;
const ACCOUNT_TIMEOUT_MS = 10_000;

export interface PlatformAccountSession {
  readonly tokenSet: OAuthTokenSet;
  readonly profile: OAuthUserProfile;
}

export interface PlatformAccountProvider {
  readonly providerId: typeof PLATFORM_PROVIDER_ID;
  readonly meta: OAuthProviderMeta;
  /** 平台服务地址；错误提示里需要它，便于用户确认客户端指向了哪台服务器。 */
  readonly origin: string;
  loginWithPassword(input: { email: string; password: string }): Promise<PlatformAccountSession>;
  /** 用会话令牌换取账号信息；平台账号的"远端校验"入口。 */
  fetchAccount(token: string): Promise<OAuthUserProfile>;
  normalizeError(error: unknown): Error;
}

interface PlatformUserPayload {
  id: string;
  email: string;
  displayName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPlatformUser(value: unknown): PlatformUserPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, email, displayName } = value;
  if (typeof id !== "string" || !id.trim()) return null;
  if (typeof email !== "string" || !email.trim()) return null;
  return {
    id: id.trim(),
    email: email.trim(),
    displayName: typeof displayName === "string" && displayName.trim() ? displayName.trim() : email.trim(),
  };
}

function readErrorMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload) && isRecord(payload.error)) {
    const message = payload.error.message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  return fallback;
}

/**
 * 令牌同时充当会话令牌与 API bearer：平台只签发一种令牌，
 * 把它写成 accessToken 与 zcodeJwtToken 是同一事实的两处表示，不是两个凭据。
 */
function toOAuthUserProfile(user: PlatformUserPayload): OAuthUserProfile {
  return {
    id: user.id,
    username: user.email,
    displayName: user.displayName,
    rawProfile: { email: user.email },
  };
}

export function createPlatformAccountProvider(
  options: { env?: NodeJS.ProcessEnv; origin?: string } = {},
): PlatformAccountProvider {
  const origin = options.origin ?? resolveRuntimeZCodeEndpointOrigin(options.env);
  const meta: OAuthProviderMeta = {
    id: PLATFORM_PROVIDER_ID,
    displayName: "RCode 账号",
    enabled: true,
    // 平台账号是商业版的主登录方式，排在厂商 provider 之前。
    order: -1,
  };

  const postJson = async (path: string, body: unknown, timeoutMs: number) => {
    let response: Response;
    try {
      response = await fetch(new URL(path, `${origin}/`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `无法连接平台服务 ${origin}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      // 登录失败要直接把服务端文案给用户看（例如"邮箱或密码不正确"），不额外拼状态码。
      throw new Error(readErrorMessage(payload, `平台服务返回 ${response.status}，请稍后重试`));
    }
    return payload;
  };

  return {
    providerId: PLATFORM_PROVIDER_ID,
    meta,
    origin,

    async loginWithPassword({ email, password }) {
      const payload = await postJson(LOGIN_PATH, { email, password }, LOGIN_TIMEOUT_MS);
      if (!isRecord(payload) || typeof payload.token !== "string" || !payload.token.trim()) {
        throw new Error("平台登录响应缺少令牌，请确认服务端版本是否匹配");
      }
      const user = readPlatformUser(payload.user);
      if (!user) {
        throw new Error("平台登录响应缺少账号信息");
      }
      const token = payload.token.trim();
      const expiresAt = typeof payload.expiresAt === "number" ? payload.expiresAt : undefined;
      return {
        tokenSet: {
          accessToken: token,
          zcodeJwtToken: token,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        },
        profile: toOAuthUserProfile(user),
      };
    },

    async fetchAccount(token) {
      let response: Response;
      try {
        response = await fetch(new URL(ACCOUNT_PATH, `${origin}/`), {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(
          `无法连接平台服务 ${origin}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
      if (!response.ok) {
        throw new Error(
          `平台服务返回 ${response.status}：${readErrorMessage(payload, "会话校验失败")}`,
        );
      }
      const user = isRecord(payload) ? readPlatformUser(payload.user) : null;
      if (!user) {
        throw new Error("平台账号信息响应非法");
      }
      return toOAuthUserProfile(user);
    },

    normalizeError(error) {
      if (error instanceof Error) {
        return error;
      }
      return new Error(`平台账号异常：${String(error)}`);
    },
  };
}
