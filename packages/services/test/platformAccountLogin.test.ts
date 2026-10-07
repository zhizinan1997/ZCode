/**
 * 平台账号登录链路：登录 → 凭据落盘 → 启动恢复 → 登出。
 *
 * 用内存凭据服务 + 假平台 provider 直接驱动 OAuthService，覆盖 M1 的验收点。
 * 不连真实平台：这里验证的是客户端侧的状态机与凭据边界，HTTPS 传输由适配器自己负责。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PLATFORM_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import type { ICredentialService } from "../src/credential/credential.js";
import { OAuthService } from "../src/oauth/oauthService.js";
import type {
  PlatformAccountProvider,
  PlatformAccountSession,
} from "../src/oauth/platformAccountProvider.js";

interface MemoryCredentialService extends ICredentialService {
  snapshot(): Record<string, string>;
}

function createMemoryCredentialService(
  initial: Record<string, string> = {},
): MemoryCredentialService {
  const store = new Map(Object.entries(initial));
  return {
    async load(key) {
      return store.get(key) ?? null;
    },
    async save(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    snapshot() {
      return Object.fromEntries(store);
    },
  };
}

/** 造一个 exp 可控的令牌；格式与真实平台令牌一致（zct1.<载荷>.<签名>）。 */
function fakeToken(expSeconds: number, subject = "usr_test"): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: subject, role: "user", sid: "ses_test", iat: 0, exp: expSeconds }),
    "utf8",
  ).toString("base64url");
  return `zct1.${payload}.test-signature`;
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600;
const PAST_EXP = Math.floor(Date.now() / 1000) - 3600;

function createFakePlatform(options: {
  token?: string;
  displayName?: string;
  loginError?: Error;
}): PlatformAccountProvider & { calls: { email: string; password: string }[] } {
  const calls: { email: string; password: string }[] = [];
  return {
    providerId: PLATFORM_PROVIDER_ID,
    origin: "https://platform.test",
    meta: {
      id: PLATFORM_PROVIDER_ID,
      displayName: "ZCode 账号",
      enabled: true,
      order: -1,
    },
    calls,
    async loginWithPassword(input) {
      calls.push(input);
      if (options.loginError) {
        throw options.loginError;
      }
      const token = options.token ?? fakeToken(FUTURE_EXP);
      const session: PlatformAccountSession = {
        tokenSet: { accessToken: token, zcodeJwtToken: token },
        profile: {
          id: "usr_test",
          username: input.email,
          displayName: options.displayName ?? "测试用户",
        },
      };
      return session;
    },
    async fetchAccount() {
      return { id: "usr_test", username: "user@example.com", displayName: "测试用户" };
    },
    normalizeError(error) {
      return error instanceof Error ? error : new Error(String(error));
    },
  };
}

function createService(options: {
  credentials?: MemoryCredentialService;
  platform?: ReturnType<typeof createFakePlatform>;
}) {
  const credentials = options.credentials ?? createMemoryCredentialService();
  const platform = options.platform ?? createFakePlatform({});
  const service = new OAuthService(credentials, { adapters: [], platformAccount: platform });
  return { service, credentials, platform };
}

test("平台账号登录后凭据落盘且 active provider 为 platform", async () => {
  const { service, credentials } = createService({});
  const result = await service.loginWithPlatformAccount({
    email: "  user@example.com  ",
    password: "secret-password",
  });

  assert.equal(result.kind, "session");
  assert.equal(result.provider, PLATFORM_PROVIDER_ID);
  assert.equal(result.userInfo.displayName, "测试用户");
  assert.equal(result.userInfo.username, "user@example.com");

  const stored = credentials.snapshot();
  assert.equal(stored["oauth:active_provider"], PLATFORM_PROVIDER_ID);
  assert.ok(stored["oauth:platform:access_token"]);
  assert.ok(stored["oauth:platform:user_info"]);
  // 会话令牌必须同时写入共享 key：启动恢复的过期判定读的就是它。
  assert.equal(stored["zcodejwttoken"], stored["oauth:platform:access_token"]);
  // 邮箱会被 trim 后再提交
  assert.equal(await service.getActiveProvider(), PLATFORM_PROVIDER_ID);
});

test("空邮箱或空密码不发请求，直接拒绝", async () => {
  const { service, platform, credentials } = createService({});
  await assert.rejects(
    () => service.loginWithPlatformAccount({ email: "   ", password: "secret" }),
    /请输入邮箱与密码/,
  );
  await assert.rejects(
    () => service.loginWithPlatformAccount({ email: "a@b.com", password: "" }),
    /请输入邮箱与密码/,
  );
  assert.equal(platform.calls.length, 0);
  assert.equal(Object.keys(credentials.snapshot()).length, 0);
});

test("登录失败不写入任何凭据", async () => {
  const platform = createFakePlatform({ loginError: new Error("邮箱或密码不正确") });
  const { service, credentials } = createService({ platform });

  await assert.rejects(
    () => service.loginWithPlatformAccount({ email: "user@example.com", password: "wrong" }),
    /邮箱或密码不正确/,
  );
  assert.equal(Object.keys(credentials.snapshot()).length, 0);
  assert.equal(await service.getActiveProvider(), null);
});

test("登录会清掉厂商残留会话（令牌与用户信息）", async () => {
  const credentials = createMemoryCredentialService({
    "oauth:active_provider": ZAI_PROVIDER_ID,
    "oauth:zai:access_token": "stale-access",
    "oauth:zai:refresh_token": "stale-refresh",
    "oauth:zai:user_info": JSON.stringify({ id: "z1", username: "z", displayName: "Z" }),
    zcodejwttoken: "stale-jwt",
  });
  const { service } = createService({ credentials });

  await service.loginWithPlatformAccount({ email: "user@example.com", password: "secret" });

  const stored = credentials.snapshot();
  assert.equal(stored["oauth:zai:access_token"], undefined);
  assert.equal(stored["oauth:zai:refresh_token"], undefined);
  assert.equal(stored["oauth:zai:user_info"], undefined);
  // 平台自己的令牌必须还在：厂商 clearProvider 会连带删 zcodejwttoken，
  // 所以登录顺序必须是"先清厂商、再写平台"。
  assert.equal(stored["oauth:active_provider"], PLATFORM_PROVIDER_ID);
  assert.equal(stored["zcodejwttoken"], stored["oauth:platform:access_token"]);
});

test("启动恢复能读回平台会话", async () => {
  const { service } = createService({});
  await service.loginWithPlatformAccount({ email: "user@example.com", password: "secret" });

  const restored = await service.restoreCachedSessionState();
  assert.equal(restored.status, "authenticated");
  if (restored.status === "authenticated") {
    assert.equal(restored.userInfo.username, "user@example.com");
    assert.equal(restored.userInfo.displayName, "测试用户");
  }
});

test("令牌过期时要求重新认证而不是静默保留登录态", async () => {
  const platform = createFakePlatform({ token: fakeToken(PAST_EXP) });
  const { service, credentials } = createService({ platform });
  await service.loginWithPlatformAccount({ email: "user@example.com", password: "secret" });

  const restored = await service.restoreCachedSessionState();
  assert.equal(restored.status, "reauthentication-required");
  // 过期会话会被清理，不能留下半截登录态
  const stored = credentials.snapshot();
  assert.equal(stored["oauth:active_provider"], undefined);
  assert.equal(stored["zcodejwttoken"], undefined);
});

test("登出后恢复为未登录", async () => {
  const { service, credentials } = createService({});
  await service.loginWithPlatformAccount({ email: "user@example.com", password: "secret" });

  await service.logout();

  assert.equal(await service.getActiveProvider(), null);
  const stored = credentials.snapshot();
  assert.equal(stored["oauth:platform:access_token"], undefined);
  assert.equal(stored["oauth:platform:user_info"], undefined);
  assert.equal(stored["zcodejwttoken"], undefined);
  assert.equal((await service.restoreCachedSessionState()).status, "signed-out");
});

test("缺缓存用户信息时视为未登录", async () => {
  const credentials = createMemoryCredentialService({
    "oauth:active_provider": PLATFORM_PROVIDER_ID,
    "oauth:platform:access_token": fakeToken(FUTURE_EXP),
    zcodejwttoken: fakeToken(FUTURE_EXP),
  });
  const { service } = createService({ credentials });
  assert.equal((await service.restoreCachedSessionState()).status, "signed-out");
});

test("缺会话令牌时视为未登录", async () => {
  const credentials = createMemoryCredentialService({
    "oauth:active_provider": PLATFORM_PROVIDER_ID,
    "oauth:platform:access_token": fakeToken(FUTURE_EXP),
    "oauth:platform:user_info": JSON.stringify({
      id: "usr_test",
      username: "user@example.com",
      displayName: "测试用户",
    }),
  });
  const { service } = createService({ credentials });
  assert.equal((await service.restoreCachedSessionState()).status, "signed-out");
});

test("provider 列表里平台账号排在最前，且包含在登出清理范围内", async () => {
  const { service, credentials } = createService({});
  const providers = await service.getProviders();
  assert.equal(providers[0]?.id, PLATFORM_PROVIDER_ID);

  await service.loginWithPlatformAccount({ email: "user@example.com", password: "secret" });
  await service.logoutAll();
  assert.equal(credentials.snapshot()["oauth:active_provider"], undefined);
  assert.equal(credentials.snapshot()["zcodejwttoken"], undefined);
});
