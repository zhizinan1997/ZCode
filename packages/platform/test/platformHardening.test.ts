/**
 * 平台安全加固行为测试（HTTP/装配层）：
 *   B1 登录限流（审计#10）、B2 管理员自我保护（审计#11）、B3 console 安全响应头（审计#12）、
 *   B7 sessions 过期清理、B8 请求体上限。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PlatformRuntime } from "../src/adapters/composition.js";
import { createPlatformApp, DEFAULT_MAX_API_BODY_BYTES } from "../src/adapters/http/app.js";
import { assertAdminPatchAllowed } from "../src/adapters/http/routes/adminUsers.js";
import { createLogger } from "../src/adapters/log.js";
import { PlatformError } from "../src/domain/errors.js";
import type { UserRecord } from "../src/domain/user.js";
import type { PlatformConfig } from "../src/adapters/config.js";
import { createTestRuntime } from "./helpers.js";

const PASSWORD = "initial-password";
const ADMIN_EMAIL = "admin@example.com";

interface Harness {
  readonly runtime: PlatformRuntime;
  readonly adminToken: string;
  readonly adminUserId: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  json(path: string, init?: RequestInit): Promise<{ status: number; body: any; headers: Headers }>;
}

async function createHarness(
  options: { maxBodyBytes?: number; config?: Partial<PlatformConfig> } = {},
): Promise<Harness> {
  const runtime = await createTestRuntime(options.config ?? {});
  const admin = await runtime.accounts.createUser({
    email: ADMIN_EMAIL,
    password: PASSWORD,
    role: "admin",
  });
  const app = createPlatformApp({
    config: runtime.config,
    logger: createLogger({ scope: "test", level: "error", write: () => {} }),
    accounts: runtime.accounts,
    billing: runtime.billing,
    catalog: runtime.catalog,
    plans: runtime.plans,
    releases: runtime.releases,
    operations: runtime.operations,
    modelPublish: runtime.modelPublish,
    gateway: runtime.gateway,
    providers: runtime.repositories.providers,
    prices: runtime.repositories.prices,
    usage: runtime.repositories.usage,
    now: () => Date.now(),
    newProviderId: runtime.newProviderId,
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
  });
  const login = await runtime.accounts.login({ email: ADMIN_EMAIL, password: PASSWORD });

  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && typeof init.body === "string") {
      headers.set("content-type", "application/json");
    }
    return await app.request(path, { ...init, headers });
  };

  return {
    runtime,
    adminToken: login.token,
    adminUserId: admin.id,
    request,
    async json(path, init) {
      const response = await request(path, init);
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null,
        headers: response.headers,
      };
    },
  };
}

async function withHarness(
  run: (harness: Harness) => Promise<void>,
  options: { maxBodyBytes?: number; config?: Partial<PlatformConfig> } = {},
): Promise<void> {
  const harness = await createHarness(options);
  try {
    await run(harness);
  } finally {
    harness.runtime.dispose();
  }
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function loginBody(email: string, password: string, ip?: string): RequestInit {
  const headers: Record<string, string> = {};
  if (ip) {
    headers["x-forwarded-for"] = ip;
  }
  return { method: "POST", body: JSON.stringify({ email, password }), headers };
}

async function expectLoginStatus(
  json: Harness["json"],
  email: string,
  password: string,
  ip: string,
  expected: number,
  label: string,
): Promise<Awaited<ReturnType<Harness["json"]>>> {
  const result = await json("/api/auth/login", loginBody(email, password, ip));
  assert.equal(result.status, expected, `${label}（期望 ${expected}，实际 ${result.status}）`);
  return result;
}

// ---------------------------------------------------------------------------
// B1 登录限流（审计#10）
// ---------------------------------------------------------------------------

test("登录限流：同一 IP+邮箱连续失败 5 次后锁定，正确密码也被拒（审计#10）", async () => {
  await withHarness(async ({ json }) => {
    const ip = "203.0.113.10";
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expectLoginStatus(json, ADMIN_EMAIL, "wrong-password", ip, 401, `第 ${attempt} 次失败`);
    }
    // 第 5 次失败仍返回 401，但同时开启锁定
    await expectLoginStatus(json, ADMIN_EMAIL, "wrong-password", ip, 401, "第 5 次失败");
    const locked = await expectLoginStatus(json, ADMIN_EMAIL, PASSWORD, ip, 429, "锁定后正确密码");
    assert.equal(locked.body.error.code, "too_many_requests");
    const retryAfter = Number(locked.headers.get("retry-after"));
    assert.ok(
      Number.isFinite(retryAfter) && retryAfter >= 1,
      `应有 Retry-After，实际 ${retryAfter}`,
    );
  });
});

test("登录限流：成功登录清零失败计数（审计#10）", async () => {
  await withHarness(async ({ json }) => {
    const ip = "203.0.113.11";
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expectLoginStatus(
        json,
        ADMIN_EMAIL,
        "wrong-password",
        ip,
        401,
        `第一轮第 ${attempt} 次`,
      );
    }
    await expectLoginStatus(json, ADMIN_EMAIL, PASSWORD, ip, 200, "成功登录（清零）");
    // 清零后重新计数：连续 4 次失败都不该触发锁定（若未清零，第 5 次整体失败后就会 429）
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expectLoginStatus(
        json,
        ADMIN_EMAIL,
        "wrong-password",
        ip,
        401,
        `第二轮第 ${attempt} 次`,
      );
    }
    await expectLoginStatus(json, ADMIN_EMAIL, PASSWORD, ip, 200, "第二轮成功登录");
  });
});

test("登录限流：按 IP+邮箱隔离，换 IP 不受锁定影响（审计#10）", async () => {
  await withHarness(async ({ json }) => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expectLoginStatus(
        json,
        ADMIN_EMAIL,
        "wrong-password",
        "203.0.113.12",
        401,
        `锁定前第 ${attempt} 次`,
      );
    }
    await expectLoginStatus(json, ADMIN_EMAIL, PASSWORD, "203.0.113.12", 429, "同一 IP 被锁定");
    // 换一个 IP：同样的邮箱仍然可以登录
    await expectLoginStatus(json, ADMIN_EMAIL, PASSWORD, "203.0.113.13", 200, "换 IP 后正常登录");
  });
});

test("登录限流：请求体非法不计入失败计数（审计#10）", async () => {
  await withHarness(async ({ json, request }) => {
    const ip = "203.0.113.14";
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const malformed = await request("/api/auth/login", {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
      });
      assert.equal(malformed.status, 400, `第 ${attempt} 次非法请求应 400`);
    }
    // 畸形请求不采样：随后的正常失败仍从第 1 次算起
    await expectLoginStatus(json, ADMIN_EMAIL, "wrong-password", ip, 401, "第一次真实失败");
  });
});

// ---------------------------------------------------------------------------
// B2 管理员自我保护（审计#11）
// ---------------------------------------------------------------------------

test("管理员不能停用或降级自己（审计#11）", async () => {
  await withHarness(async ({ json, adminToken, adminUserId }) => {
    const disabled = await json(`/api/admin/users/${adminUserId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "disabled" }),
      headers: auth(adminToken),
    });
    assert.equal(disabled.status, 403);
    assert.equal(disabled.body.error.code, "forbidden");

    const demoted = await json(`/api/admin/users/${adminUserId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "user" }),
      headers: auth(adminToken),
    });
    assert.equal(demoted.status, 403);
    assert.equal(demoted.body.error.code, "forbidden");

    // 无实际变化的自我 PATCH 按幂等放行，且账号保持 admin/active
    const noop = await json(`/api/admin/users/${adminUserId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "admin", status: "active" }),
      headers: auth(adminToken),
    });
    assert.equal(noop.status, 200);
    const me = await json("/api/auth/me", { headers: auth(adminToken) });
    assert.equal(me.body.user.role, "admin");
    assert.equal(me.body.user.status, "active");
  });
});

test("有多个管理员时，降级另一名管理员仍然允许（审计#11）", async () => {
  await withHarness(async ({ json, adminToken, runtime }) => {
    const second = await runtime.accounts.createUser({
      email: "admin2@example.com",
      password: PASSWORD,
      role: "admin",
    });
    const demoted = await json(`/api/admin/users/${second.id}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "user" }),
      headers: auth(adminToken),
    });
    assert.equal(demoted.status, 200);
    assert.equal(demoted.body.user.role, "user");
  });
});

test("最后一个启用管理员保护：会移除最后管理员的变更被拒（审计#11）", () => {
  const activeAdmin: UserRecord = {
    id: "u-target",
    email: "target@example.com",
    displayName: "target",
    passwordHash: "scrypt$placeholder",
    role: "admin",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
  const conflict = (error: unknown) => error instanceof PlatformError && error.code === "conflict";
  const forbidden = (error: unknown) =>
    error instanceof PlatformError && error.code === "forbidden";

  // 操作者是目标自己：自我停用/降级一律 403
  assert.throws(
    () =>
      assertAdminPatchAllowed({
        actorUserId: "u-target",
        target: activeAdmin,
        nextRole: "user",
        nextStatus: "active",
        activeAdminCount: 2,
      }),
    forbidden,
  );
  assert.throws(
    () =>
      assertAdminPatchAllowed({
        actorUserId: "u-target",
        target: activeAdmin,
        nextRole: "admin",
        nextStatus: "disabled",
        activeAdminCount: 2,
      }),
    forbidden,
  );
  // 操作者是别人、目标已是最后一个启用管理员：409
  assert.throws(
    () =>
      assertAdminPatchAllowed({
        actorUserId: "u-other",
        target: activeAdmin,
        nextRole: "user",
        nextStatus: "active",
        activeAdminCount: 1,
      }),
    conflict,
  );
  assert.throws(
    () =>
      assertAdminPatchAllowed({
        actorUserId: "u-other",
        target: activeAdmin,
        nextRole: "admin",
        nextStatus: "disabled",
        activeAdminCount: 1,
      }),
    conflict,
  );
  // 还有第二个启用管理员：允许降级
  assertAdminPatchAllowed({
    actorUserId: "u-other",
    target: activeAdmin,
    nextRole: "user",
    nextStatus: "active",
    activeAdminCount: 2,
  });
  // 目标已停用或已不是管理员：不触发保护
  assertAdminPatchAllowed({
    actorUserId: "u-other",
    target: { ...activeAdmin, status: "disabled" },
    nextRole: "user",
    nextStatus: "disabled",
    activeAdminCount: 1,
  });
  assertAdminPatchAllowed({
    actorUserId: "u-other",
    target: { ...activeAdmin, role: "user" },
    nextRole: "user",
    nextStatus: "disabled",
    activeAdminCount: 1,
  });
});

// ---------------------------------------------------------------------------
// B3 console 安全响应头（审计#12）
// ---------------------------------------------------------------------------

test("管理后台静态资源带安全响应头，API 响应不带（审计#12）", async () => {
  await withHarness(async ({ request }) => {
    for (const path of ["/", "/console/app.js", "/console/styles.css"]) {
      const response = await request(path);
      assert.equal(response.status, 200, `${path} 应可访问`);
      const csp = response.headers.get("content-security-policy") ?? "";
      assert.match(csp, /default-src 'self'/, `${path} 应有 CSP`);
      assert.equal(csp.includes("unsafe-inline"), false, `${path} 不应放开 unsafe-inline`);
      assert.equal(response.headers.get("x-frame-options"), "DENY", `${path} 应禁止被嵌入`);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer", `${path}`);
    }

    // API 响应不属于文档，不带 CSP
    const health = await request("/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("content-security-policy"), null);
  });
});

// ---------------------------------------------------------------------------
// B7 sessions 过期清理
// ---------------------------------------------------------------------------

test("启动时清理过期会话，未过期会话保留（B7）", async () => {
  const directory = await mkdtemp(join(tmpdir(), "platform-sessions-"));
  const dbPath = join(directory, "platform.sqlite");
  try {
    const first = await createTestRuntime({ dbPath });
    const user = await first.accounts.createUser({
      email: "sessions@example.com",
      password: "session-password",
    });
    const now = Date.now();
    await first.repositories.sessions.insert({
      id: "sess-expired",
      userId: user.id,
      createdAt: now - 5_000,
      expiresAt: now - 1_000,
      revokedAt: null,
      userAgent: null,
    });
    await first.repositories.sessions.insert({
      id: "sess-alive",
      userId: user.id,
      createdAt: now,
      expiresAt: now + 60_000,
      revokedAt: null,
      userAgent: null,
    });
    first.dispose();

    // 重新打开同一个数据库：装配时的清理应删掉过期记录、保留未过期记录
    const second = await createTestRuntime({ dbPath });
    try {
      assert.equal(await second.repositories.sessions.findById("sess-expired"), null);
      assert.ok(await second.repositories.sessions.findById("sess-alive"));

      // 直接调用仓储方法同样按 expires_at 判定
      await second.repositories.sessions.insert({
        id: "sess-expired-2",
        userId: user.id,
        createdAt: now,
        expiresAt: Date.now() - 1,
        revokedAt: null,
        userAgent: null,
      });
      assert.equal(await second.repositories.sessions.deleteExpiredBefore(Date.now()), 1);
      assert.equal(await second.repositories.sessions.findById("sess-expired-2"), null);
      assert.ok(await second.repositories.sessions.findById("sess-alive"));
    } finally {
      second.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B8 请求体上限
// ---------------------------------------------------------------------------

test("超过上限的请求体返回 413，未超限请求不受影响（B8）", async () => {
  assert.equal(DEFAULT_MAX_API_BODY_BYTES, 32 * 1024 * 1024);
  await withHarness(
    async ({ json }) => {
      // 没有 content-length 时走流式计数路径（app.request 构造的 Request 不带头）
      const rejected = await json("/api/auth/login", loginBody(ADMIN_EMAIL, "x".repeat(2048)));
      assert.equal(rejected.status, 413);
      assert.equal(rejected.body.error.code, "payload_too_large");

      const normal = await json("/api/auth/login", loginBody(ADMIN_EMAIL, PASSWORD));
      assert.equal(normal.status, 200);

      const wrong = await json("/api/auth/login", loginBody(ADMIN_EMAIL, "wrong-password"));
      assert.equal(wrong.status, 401);
    },
    { maxBodyBytes: 1024 },
  );
});

test("带 content-length 的超限请求立即 413（B8）", async () => {
  await withHarness(
    async ({ request }) => {
      const response = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: ADMIN_EMAIL, password: "x".repeat(4096) }),
        headers: { "content-type": "application/json", "content-length": "4096" },
      });
      assert.equal(response.status, 413);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "payload_too_large");
    },
    { maxBodyBytes: 1024 },
  );
});
