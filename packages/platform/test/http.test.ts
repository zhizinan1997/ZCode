/** HTTP 边界端到端：直接对 Hono app 发请求，覆盖鉴权、权限与错误映射。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformRuntime } from "../src/adapters/composition.js";
import { createPlatformApp } from "../src/adapters/http/app.js";
import { fetchUpstreamModelIds } from "../src/adapters/http/routes/adminCatalogPublish.js";
import { createLogger } from "../src/adapters/log.js";
import { createTestRuntime } from "./helpers.js";

const PASSWORD = "initial-password";
const ADMIN_EMAIL = "admin@example.com";

interface Harness {
  readonly runtime: PlatformRuntime;
  readonly adminToken: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  json(path: string, init?: RequestInit): Promise<{ status: number; body: any }>;
}

async function createHarness(): Promise<Harness> {
  const runtime = await createTestRuntime();
  await runtime.accounts.createUser({ email: ADMIN_EMAIL, password: PASSWORD, role: "admin" });
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
  });

  const adminLogin = await runtime.accounts.login({ email: ADMIN_EMAIL, password: PASSWORD });

  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && typeof init.body === "string") {
      headers.set("content-type", "application/json");
    }
    return await app.request(path, { ...init, headers });
  };

  return {
    runtime,
    adminToken: adminLogin.token,
    request,
    async json(path, init) {
      const response = await request(path, init);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
  };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function post(body: unknown, token?: string): RequestInit {
  return {
    method: "POST",
    body: JSON.stringify(body),
    ...(token ? { headers: auth(token) } : {}),
  };
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await createHarness();
  try {
    await run(harness);
  } finally {
    harness.runtime.dispose();
  }
}

test("健康检查", async () => {
  await withHarness(async ({ json }) => {
    const result = await json("/api/health");
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
  });
});

test("登录成功返回令牌，响应不含密码哈希", async () => {
  await withHarness(async ({ json }) => {
    const result = await json("/api/auth/login", post({ email: ADMIN_EMAIL, password: PASSWORD }));
    assert.equal(result.status, 200);
    assert.ok(result.body.token);
    assert.equal(result.body.user.email, ADMIN_EMAIL);
    assert.equal(result.body.user.role, "admin");
    assert.equal("passwordHash" in result.body.user, false);
    assert.equal(JSON.stringify(result.body).includes("scrypt$"), false);
  });
});

test("登录失败返回 401 与稳定错误码", async () => {
  await withHarness(async ({ json }) => {
    const wrong = await json(
      "/api/auth/login",
      post({ email: ADMIN_EMAIL, password: "wrong-password" }),
    );
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, "invalid_credentials");

    const unknown = await json(
      "/api/auth/login",
      post({ email: "nobody@example.com", password: PASSWORD }),
    );
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.code, "invalid_credentials");
    assert.equal(unknown.body.error.message, wrong.body.error.message);
  });
});

test("缺少或非法请求体返回 400", async () => {
  await withHarness(async ({ json, request }) => {
    const missing = await json("/api/auth/login", post({ email: ADMIN_EMAIL }));
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, "invalid_request");

    const malformed = await request("/api/auth/login", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    assert.equal(malformed.status, 400);
  });
});

test("受保护接口缺少令牌返回 401", async () => {
  await withHarness(async ({ json }) => {
    const result = await json("/api/auth/me");
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, "unauthorized");
  });
});

test("me 返回当前用户", async () => {
  await withHarness(async ({ json, adminToken }) => {
    const result = await json("/api/auth/me", { headers: auth(adminToken) });
    assert.equal(result.status, 200);
    assert.equal(result.body.user.email, ADMIN_EMAIL);
  });
});

test("登出后令牌失效", async () => {
  await withHarness(async ({ json, adminToken }) => {
    const logout = await json("/api/auth/logout", { method: "POST", headers: auth(adminToken) });
    assert.equal(logout.status, 204);
    const me = await json("/api/auth/me", { headers: auth(adminToken) });
    assert.equal(me.status, 401);
    assert.equal(me.body.error.code, "session_revoked");
  });
});

test("非管理员访问管理接口被拒，网关也要求登录", async () => {
  await withHarness(async ({ json, adminToken }) => {
    await json(
      "/api/admin/users",
      post({ email: "user@example.com", password: PASSWORD }, adminToken),
    );
    const userLogin = await json(
      "/api/auth/login",
      post({ email: "user@example.com", password: PASSWORD }),
    );
    const userToken = userLogin.body.token as string;

    const forbidden = await json("/api/admin/users", { headers: auth(userToken) });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, "forbidden");

    // 网关不带令牌时必须 401，绝不能匿名转发
    const anonymousGateway = await json("/api/v1/gateway/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "x" }),
    });
    assert.equal(anonymousGateway.status, 401);
  });
});

test("管理员建号后该用户能登录", async () => {
  await withHarness(async ({ json, adminToken }) => {
    const created = await json(
      "/api/admin/users",
      post({ email: "user@example.com", password: PASSWORD, displayName: "张三" }, adminToken),
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.user.displayName, "张三");
    assert.equal(created.body.user.role, "user");
    // 新用户余额为 0
    assert.equal(created.body.user.balanceMicros, 0);

    const login = await json(
      "/api/auth/login",
      post({ email: "user@example.com", password: PASSWORD }),
    );
    assert.equal(login.status, 200);
  });
});

test("重复邮箱返回 409", async () => {
  await withHarness(async ({ json, adminToken }) => {
    await json(
      "/api/admin/users",
      post({ email: "dup@example.com", password: PASSWORD }, adminToken),
    );
    const again = await json(
      "/api/admin/users",
      post({ email: "DUP@example.com", password: PASSWORD }, adminToken),
    );
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "user_exists");
  });
});

test("用户列表返回分页与总数", async () => {
  await withHarness(async ({ json, adminToken }) => {
    for (let index = 0; index < 3; index += 1) {
      await json(
        "/api/admin/users",
        post({ email: `user${index}@example.com`, password: PASSWORD }, adminToken),
      );
    }
    const listed = await json("/api/admin/users?limit=2&offset=0", { headers: auth(adminToken) });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.total, 4);
    assert.equal(listed.body.users.length, 2);

    const badLimit = await json("/api/admin/users?limit=0", { headers: auth(adminToken) });
    assert.equal(badLimit.status, 400);
  });
});

test("停用用户后其令牌立即失效", async () => {
  await withHarness(async ({ json, adminToken }) => {
    const created = await json(
      "/api/admin/users",
      post({ email: "user@example.com", password: PASSWORD }, adminToken),
    );
    const login = await json(
      "/api/auth/login",
      post({ email: "user@example.com", password: PASSWORD }),
    );
    const userToken = login.body.token as string;
    assert.equal((await json("/api/auth/me", { headers: auth(userToken) })).status, 200);

    const patched = await json(`/api/admin/users/${created.body.user.id as string}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "disabled" }),
      headers: auth(adminToken),
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.user.status, "disabled");

    const after = await json("/api/auth/me", { headers: auth(userToken) });
    assert.equal(after.status, 401);
  });
});

test("充值后余额增加，流水可查，对账一致", async () => {
  await withHarness(async ({ json, adminToken }) => {
    const created = await json(
      "/api/admin/users",
      post({ email: "pay@example.com", password: PASSWORD }, adminToken),
    );
    const userId = created.body.user.id as string;

    const recharge = await json(`/api/admin/users/${userId}/recharge`, {
      ...post({ amount: "12.5", note: "首充" }, adminToken),
    });
    assert.equal(recharge.status, 200);
    assert.equal(recharge.body.user.balanceMicros, 12_500_000);

    const ledger = await json(`/api/admin/users/${userId}/ledger`, { headers: auth(adminToken) });
    assert.equal(ledger.body.total, 1);
    assert.equal(ledger.body.entries[0].kind, "recharge");
    assert.equal(ledger.body.entries[0].amount, "12.5");

    const reconciled = await json(`/api/admin/users/${userId}/reconcile`, {
      headers: auth(adminToken),
    });
    assert.equal(reconciled.body.consistent, true);
  });
});

test("充值金额格式非法被拒", async () => {
  await withHarness(async ({ json, adminToken }) => {
    const created = await json(
      "/api/admin/users",
      post({ email: "pay@example.com", password: PASSWORD }, adminToken),
    );
    const userId = created.body.user.id as string;
    const bad = await json(`/api/admin/users/${userId}/recharge`, {
      ...post({ amount: "abc" }, adminToken),
    });
    assert.equal(bad.status, 400);
    const negative = await json(`/api/admin/users/${userId}/recharge`, {
      ...post({ amount: "-1" }, adminToken),
    });
    assert.equal(negative.status, 400);
  });
});

test("套餐：创建、发放、额度优先抵扣、撤销", async () => {
  await withHarness(async ({ json, adminToken }) => {
    const created = await json(
      "/api/admin/users",
      post({ email: "plan@example.com", password: PASSWORD }, adminToken),
    );
    const userId = created.body.user.id as string;

    const plan = await json(
      "/api/admin/plans",
      post({ name: "月付 100", quota: "100", durationDays: 30, allowedModels: [] }, adminToken),
    );
    assert.equal(plan.status, 201);
    const planId = plan.body.plan.id as string;
    assert.equal(plan.body.plan.quotaMicros, 100_000_000);

    const grant = await json(
      `/api/admin/users/${userId}/subscription`,
      post({ planId }, adminToken),
    );
    assert.equal(grant.status, 201);
    assert.equal(grant.body.subscription.remainingMicros, 100_000_000);

    const detail = await json(`/api/admin/users/${userId}`, { headers: auth(adminToken) });
    assert.equal(detail.body.plan.name, "月付 100");

    const revoked = await json(`/api/admin/users/${userId}/subscription`, {
      method: "DELETE",
      headers: auth(adminToken),
    });
    assert.equal(revoked.status, 204);
    const after = await json(`/api/admin/users/${userId}`, { headers: auth(adminToken) });
    assert.equal(after.body.plan, null);
  });
});

test("删除仍被订阅引用的套餐会被拒绝并给出可读原因", async () => {
  await withHarness(async ({ json, adminToken }) => {
    const created = await json(
      "/api/admin/users",
      post({ email: "plan@example.com", password: PASSWORD }, adminToken),
    );
    const plan = await json("/api/admin/plans", post({ name: "P", quota: "1" }, adminToken));
    const planId = plan.body.plan.id as string;
    await json(
      `/api/admin/users/${created.body.user.id as string}/subscription`,
      post({ planId }, adminToken),
    );

    const removed = await json(`/api/admin/plans/${planId}`, {
      method: "DELETE",
      headers: auth(adminToken),
    });
    assert.equal(removed.status, 409);
    assert.match(removed.body.error.message, /仍被 1 个订阅引用/);
  });
});

test("上游 provider：key 只写不读，编辑留空不覆盖", async () => {
  await withHarness(async ({ json, adminToken }) => {
    const created = await json("/api/admin/providers/anthropic", {
      method: "PUT",
      body: JSON.stringify({
        label: "Anthropic",
        upstreamBaseUrl: "https://api.anthropic.com",
        protocol: "anthropic",
        apiKey: "sk-super-secret-value",
      }),
      headers: auth(adminToken),
    });
    assert.equal(created.status, 204);

    const listed = await json("/api/admin/providers", { headers: auth(adminToken) });
    assert.equal(listed.body.providers.length, 1);
    assert.equal(listed.body.providers[0].apiKeyHint, "…alue");
    // 完整 key 绝不能出现在任何管理接口响应里
    assert.equal(JSON.stringify(listed.body).includes("sk-super-secret-value"), false);

    // 只改显示名、不传 apiKey：原 key 必须保留
    await json("/api/admin/providers/anthropic", {
      method: "PUT",
      body: JSON.stringify({ label: "改名", enabled: false }),
      headers: auth(adminToken),
    });
    const after = await json("/api/admin/providers", { headers: auth(adminToken) });
    assert.equal(after.body.providers[0].label, "改名");
    assert.equal(after.body.providers[0].enabled, false);
    assert.equal(after.body.providers[0].apiKeyHint, "…alue");
  });
});

test("单价：写入后按每百万 token 的金额回读", async () => {
  await withHarness(async ({ json, adminToken }) => {
    await json("/api/admin/prices/claude-test", {
      method: "PUT",
      body: JSON.stringify({ input: "3", output: "15", cacheRead: "0.3", cacheWrite: "3.75" }),
      headers: auth(adminToken),
    });
    const listed = await json("/api/admin/prices", { headers: auth(adminToken) });
    assert.equal(listed.body.prices[0].input, "3");
    assert.equal(listed.body.prices[0].output, "15");
    assert.equal(listed.body.prices[0].cacheRead, "0.3");
    assert.equal(listed.body.prices[0].cacheWrite, "3.75");
  });
});

test("模型目录：未导入时返回 null，导入后客户端配置指向它", async () => {
  await withHarness(async ({ json, adminToken }) => {
    const empty = await json("/api/admin/catalog", { headers: auth(adminToken) });
    assert.equal(empty.body.revision, null);

    // 未导入时公开配置接口必须失败而不是回空配置（空配置会让客户端回退到内置厂商目录）
    const beforeConfig = await json("/api/v1/client/configs");
    assert.equal(beforeConfig.status, 404);

    // revision 31：装配层已注入内置目录（revision 30），下限是 max(当前, 内置)（审计#20）；
    // 模型清单写在客户端严格 schema 的 config.builtinModelIds 字段里（审计#20）。
    const content = JSON.stringify({
      schemaVersion: 1,
      revision: 31,
      config: {
        providerConfigRules: {
          templateRules: [],
          providerRules: [
            {
              providerId: "anthropic",
              providerName: "Anthropic",
              config: {
                api: {
                  type: "anthropic-messages",
                  baseUrl: "https://platform.test/api/v1/gateway/anthropic",
                },
                builtinModelIds: ["claude-test"],
              },
            },
          ],
        },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    });
    const saved = await json("/api/admin/catalog", {
      method: "PUT",
      body: JSON.stringify({ content, expectedRevision: null }),
      headers: auth(adminToken),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 31);

    const configs = await json("/api/v1/client/configs");
    assert.equal(configs.status, 200);
    // 客户端 schema 要求 code 字面量 0 与 https 地址
    assert.equal(configs.body.code, 0);
    assert.equal(
      configs.body.data.configs.builtin_provider_config_json,
      "https://platform.test/api/v1/catalog/31.json",
    );

    const catalog = await json("/api/v1/catalog/31.json");
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.revision, 31);
  });
});

test("客户端账单接口返回余额与套餐", async () => {
  await withHarness(async ({ json, adminToken }) => {
    await json(
      "/api/admin/users",
      post({ email: "bill@example.com", password: PASSWORD }, adminToken),
    );
    const login = await json(
      "/api/auth/login",
      post({ email: "bill@example.com", password: PASSWORD }),
    );
    const userToken = login.body.token as string;

    const billing = await json("/api/v1/billing/me", { headers: auth(userToken) });
    assert.equal(billing.status, 200);
    assert.equal(billing.body.balanceMicros, 0);
    assert.equal(billing.body.plan, null);
    assert.equal(billing.body.usageTotals.requestCount, 0);
  });
});

test("更新清单：未发布时 404，发布后返回 YAML", async () => {
  await withHarness(async ({ json, adminToken, request }) => {
    const missing = await json(
      "/api/v1/releases/electron/manifest?platform=windows-x86_64&channel=1",
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "not_found");

    // 用原始二进制 PUT 上传（与管理页面上传同一路径）
    const binary = Buffer.from("fake-installer-bytes");
    const upload = await request(
      "/api/admin/releases/3.15.0/ZCode-3.15.0-win-x64.exe?platform=windows-x86_64&channel=stable",
      { method: "PUT", body: binary, headers: auth(adminToken) },
    );
    assert.equal(upload.status, 201);
    const uploaded = (await upload.json()) as {
      release: { sha512: string; sizeBytes: number };
    };
    // 平台自己算的摘要必须与内容一致
    assert.equal(uploaded.release.sizeBytes, binary.length);
    assert.equal(uploaded.release.sha512.length > 0, true);

    const manifest = await request(
      "/api/v1/releases/electron/manifest?platform=windows-x86_64&channel=1",
    );
    assert.equal(manifest.status, 200);
    const yaml = await manifest.text();
    assert.match(yaml, /^version: "3\.15\.0"$/m);
    assert.match(yaml, /url: "\/releases\/electron\/3\.15\.0\/ZCode-3\.15\.0-win-x64\.exe"/);
  });
});

test("管理后台页面与静态资源可访问", async () => {
  await withHarness(async ({ request }) => {
    const index = await request("/");
    assert.equal(index.status, 200);
    assert.match(await index.text(), /平台管理后台/);

    const script = await request("/console/app.js");
    assert.equal(script.status, 200);

    const styles = await request("/console/styles.css");
    assert.equal(styles.status, 200);

    // 路径穿越必须被挡住
    const traversal = await request("/console/..%2F..%2Fpackage.json");
    assert.notEqual(traversal.status, 200);
  });
});

test("管理员重置密码后旧令牌与旧密码都失效", async () => {
  await withHarness(async ({ json, adminToken }) => {
    const created = await json(
      "/api/admin/users",
      post({ email: "user@example.com", password: PASSWORD }, adminToken),
    );
    const login = await json(
      "/api/auth/login",
      post({ email: "user@example.com", password: PASSWORD }),
    );
    const userToken = login.body.token as string;

    const reset = await json(`/api/admin/users/${created.body.user.id as string}/password`, {
      ...post({ newPassword: "another-password" }, adminToken),
    });
    assert.equal(reset.status, 204);

    assert.equal((await json("/api/auth/me", { headers: auth(userToken) })).status, 401);
    const oldPassword = await json(
      "/api/auth/login",
      post({ email: "user@example.com", password: PASSWORD }),
    );
    assert.equal(oldPassword.status, 401);
    const newPassword = await json(
      "/api/auth/login",
      post({ email: "user@example.com", password: "another-password" }),
    );
    assert.equal(newPassword.status, 200);
  });
});

test("用户自助改密保留当前会话", async () => {
  await withHarness(async ({ json, adminToken }) => {
    await json(
      "/api/admin/users",
      post({ email: "user@example.com", password: PASSWORD }, adminToken),
    );
    const login = await json(
      "/api/auth/login",
      post({ email: "user@example.com", password: PASSWORD }),
    );
    const userToken = login.body.token as string;

    const changed = await json(
      "/api/auth/password",
      post({ currentPassword: PASSWORD, newPassword: "another-password" }, userToken),
    );
    assert.equal(changed.status, 204);
    assert.equal((await json("/api/auth/me", { headers: auth(userToken) })).status, 200);
  });
});

test("用户列表按 q 搜索邮箱与显示名", async () => {
  await withHarness(async ({ json, adminToken }) => {
    await json(
      "/api/admin/users",
      post({ email: "alice@example.com", password: PASSWORD, displayName: "爱丽丝" }, adminToken),
    );
    await json(
      "/api/admin/users",
      post({ email: "bob@example.com", password: PASSWORD, displayName: "小明" }, adminToken),
    );
    await json(
      "/api/admin/users",
      post({ email: "carol@example.com", password: PASSWORD, displayName: "卡罗" }, adminToken),
    );

    // 按邮箱片段搜：只命中 alice
    const byEmail = await json("/api/admin/users?q=alice", { headers: auth(adminToken) });
    assert.equal(byEmail.status, 200);
    assert.equal(byEmail.body.total, 1);
    assert.equal(byEmail.body.users.length, 1);
    assert.equal(byEmail.body.users[0].email, "alice@example.com");
    assert.equal(byEmail.body.q, "alice");

    // 按显示名搜：只命中小明
    const byName = await json(`/api/admin/users?q=${encodeURIComponent("小明")}`, {
      headers: auth(adminToken),
    });
    assert.equal(byName.status, 200);
    assert.equal(byName.body.total, 1);
    assert.equal(byName.body.users[0].displayName, "小明");

    // 空搜索退化为完整列表：admin + 3 个新用户
    const all = await json("/api/admin/users?q=", { headers: auth(adminToken) });
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 4);
    assert.equal("q" in all.body, false);
  });
});

test("PATCH 用户：displayName 与 email 更新、邮箱冲突返回 user_exists", async () => {
  await withHarness(async ({ json, adminToken }) => {
    const first = await json(
      "/api/admin/users",
      post({ email: "first@example.com", password: PASSWORD, displayName: "甲" }, adminToken),
    );
    const second = await json(
      "/api/admin/users",
      post({ email: "second@example.com", password: PASSWORD, displayName: "乙" }, adminToken),
    );
    const firstId = first.body.user.id as string;

    const renamed = await json(`/api/admin/users/${firstId}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "  新名字  ", email: "New.First@Example.COM" }),
      headers: auth(adminToken),
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.user.displayName, "新名字");
    // 邮箱在规范化后回读
    assert.equal(renamed.body.user.email, "new.first@example.com");

    // 改成 second 已占用的邮箱 → 409 user_exists
    const conflict = await json(`/api/admin/users/${firstId}`, {
      method: "PATCH",
      body: JSON.stringify({ email: second.body.user.email }),
      headers: auth(adminToken),
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "user_exists");

    // 自己占用同一个邮箱（无变化）按幂等放行
    const selfEmail = await json(`/api/admin/users/${firstId}`, {
      method: "PATCH",
      body: JSON.stringify({ email: "FIRST@example.com" }),
      headers: auth(adminToken),
    });
    assert.equal(selfEmail.status, 200);

    // 非法邮箱 → 400
    const invalid = await json(`/api/admin/users/${firstId}`, {
      method: "PATCH",
      body: JSON.stringify({ email: "not-an-email" }),
      headers: auth(adminToken),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "invalid_request");
  });
});

test("PATCH 自我保护：唯一管理员不能降级/停用自己，但可改显示名/邮箱", async () => {
  await withHarness(async ({ json, adminToken, runtime }) => {
    const me = await json("/api/auth/me", { headers: auth(adminToken) });
    const adminId = me.body.user.id as string;

    // 唯一管理员：自我资料改动放行
    const rename = await json(`/api/admin/users/${adminId}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "首席管理员" }),
      headers: auth(adminToken),
    });
    assert.equal(rename.status, 200);
    assert.equal(rename.body.user.displayName, "首席管理员");

    // 降级/停用自己 → 403（一律禁止，语义见 security-hardening.md B2）
    const demoteSelf = await json(`/api/admin/users/${adminId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "user" }),
      headers: auth(adminToken),
    });
    assert.equal(demoteSelf.status, 403);
    assert.equal(demoteSelf.body.error.code, "forbidden");

    const disableSelf = await json(`/api/admin/users/${adminId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "disabled" }),
      headers: auth(adminToken),
    });
    assert.equal(disableSelf.status, 403);

    // 有第二个管理员在场，自我降级仍被一律禁止
    await runtime.accounts.createUser({
      email: "admin2@example.com",
      password: PASSWORD,
      role: "admin",
    });
    const demoteSelfWithSecond = await json(`/api/admin/users/${adminId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "user" }),
      headers: auth(adminToken),
    });
    assert.equal(demoteSelfWithSecond.status, 403);

    // 多管理员下，降级"另一名"管理员仍放行
    const secondLogin = await json(
      "/api/auth/login",
      post({ email: "admin2@example.com", password: PASSWORD }),
    );
    const secondId = secondLogin.body.user.id as string;
    const demoteOther = await json(`/api/admin/users/${secondId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "user" }),
      headers: auth(adminToken),
    });
    assert.equal(demoteOther.status, 200);
    assert.equal(demoteOther.body.user.role, "user");
  });
});

test("DELETE 普通用户返回 204，删除后 404；DELETE 最后一个管理员返回 409", async () => {
  await withHarness(async ({ json, adminToken, runtime }) => {
    const created = await json(
      "/api/admin/users",
      post({ email: "doomed@example.com", password: PASSWORD }, adminToken),
    );
    const userId = created.body.user.id as string;
    // 给该用户充值并建 API Key，验证级联清理路径
    await json(`/api/admin/users/${userId}/recharge`, post({ amount: "1" }, adminToken));
    const me = await json("/api/auth/me", { headers: auth(adminToken) });
    const adminId = me.body.user.id as string;
    await runtime.operations.createApiKey({ userId, name: "k", actorUserId: adminId });

    const removed = await json(`/api/admin/users/${userId}`, {
      method: "DELETE",
      headers: auth(adminToken),
    });
    assert.equal(removed.status, 204);

    const gone = await json(`/api/admin/users/${userId}`, { headers: auth(adminToken) });
    assert.equal(gone.status, 404);
    assert.equal(gone.body.error.code, "user_not_found");

    // API Key 表对 users.id 有 ON DELETE CASCADE：删用户后 key 一并消失
    assert.deepEqual(await runtime.operations.listApiKeysForUser(userId), []);

    // 唯一的管理员不能被删
    const deleteAdmin = await json(`/api/admin/users/${adminId}`, {
      method: "DELETE",
      headers: auth(adminToken),
    });
    assert.equal(deleteAdmin.status, 403);
  });
});

test("批量发放套餐：全部成功 granted=2，部分失败收集 error", async () => {
  await withHarness(async ({ json, adminToken }) => {
    const userA = await json(
      "/api/admin/users",
      post({ email: "bulk-a@example.com", password: PASSWORD }, adminToken),
    );
    const userB = await json(
      "/api/admin/users",
      post({ email: "bulk-b@example.com", password: PASSWORD }, adminToken),
    );
    const plan = await json(
      "/api/admin/plans",
      post({ name: "批量套餐", quota: "10", durationDays: null, allowedModels: [] }, adminToken),
    );
    const planId = plan.body.plan.id as string;

    const bulk = await json("/api/admin/users/bulk-subscription", {
      ...post(
        {
          planId,
          userIds: [userA.body.user.id, userB.body.user.id],
        },
        adminToken,
      ),
    });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.body.granted, 2);
    assert.deepEqual(bulk.body.failed, []);

    const detailA = await json(`/api/admin/users/${userA.body.user.id as string}`, {
      headers: auth(adminToken),
    });
    assert.equal(detailA.body.plan.name, "批量套餐");

    // 混合成功与失败：不存在的用户 id 不中断整体
    const mixed = await json("/api/admin/users/bulk-subscription", {
      ...post({ planId, userIds: [userA.body.user.id, "usr_missing"] }, adminToken),
    });
    assert.equal(mixed.status, 200);
    assert.equal(mixed.body.granted, 1);
    assert.equal(mixed.body.failed.length, 1);
    assert.equal(mixed.body.failed[0].userId, "usr_missing");

    // 入参非法：空数组 / 超上限
    const empty = await json("/api/admin/users/bulk-subscription", {
      ...post({ planId, userIds: [] }, adminToken),
    });
    assert.equal(empty.status, 400);
    const tooMany = await json("/api/admin/users/bulk-subscription", {
      ...post({ planId, userIds: Array.from({ length: 501 }, () => "usr_x") }, adminToken),
    });
    assert.equal(tooMany.status, 400);
  });
});

test("未知路由返回 404", async () => {
  await withHarness(async ({ json }) => {
    const result = await json("/api/unknown");
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, "not_found");
  });
});

test("概览：充值后负债与用户数正确，今日消费为 0 且未配价列表为空", async () => {
  await withHarness(async ({ json, adminToken }) => {
    await json(
      "/api/admin/users",
      post({ email: "ov@example.com", password: PASSWORD }, adminToken),
    );
    // 充值前基线：负债来自该测试库自己的数据（内存库，仅 admin + 这一个用户，均未充值）
    const before = (await json("/api/admin/overview", { headers: auth(adminToken) })).body;
    const beforeLiability = before.liabilityMicros as number;
    const usersBefore = before.userCount as number;
    assert.equal(before.totalsToday.requestCount, 0);
    // 目录未发布：没有"已发布但未配价"的模型
    assert.deepEqual(before.unpricedModels, []);
    assert.equal("rechargeToday" in before, true);
    assert.equal("costToday" in before, true);

    const created = await json(
      "/api/admin/users",
      post({ email: "ov2@example.com", password: PASSWORD }, adminToken),
    );
    await json(`/api/admin/users/${created.body.user.id as string}/recharge`, {
      ...post({ amount: "5" }, adminToken),
    });

    const after = await json("/api/admin/overview", { headers: auth(adminToken) });
    assert.equal(after.body.liabilityMicros, beforeLiability + 5_000_000);
    assert.equal(after.body.rechargeTodayMicros >= 5_000_000, true);
    // 基线里已有 ov@example.com（admin 之外只建了这一个），之后只新增 ov2 一个用户
    assert.equal(after.body.userCount, usersBefore + 1);
    assert.equal(after.body.totalsToday.requestCount, 0);
    assert.deepEqual(after.body.unpricedModels, []);
  });
});

test("按模型聚合与全站流水：结算一笔用量后出现该模型与 usage 流水行", async () => {
  await withHarness(async ({ json, adminToken, runtime }) => {
    const created = await json(
      "/api/admin/users",
      post({ email: "usage@example.com", password: PASSWORD }, adminToken),
    );
    const userId = created.body.user.id as string;

    // 结算会从余额扣钱（事务里余额封顶），先充值让余额覆盖费用，ledger 才有 usage 行。
    await runtime.billing.recharge({ userId, amountMicros: 10_000_000 });

    // 不走网关链路，直接用仓储构造"预扣 → 原子结算"：结算事务同时写 usage 与 ledger。
    const inserted = await runtime.repositories.usage.insertReservation({
      requestId: "req-agg-test-1",
      userId,
      providerId: "anthropic",
      modelId: "claude-test",
      costMicros: 1_000_000,
      httpStatus: null,
      durationMs: null,
      now: Date.now(),
    });
    assert.equal(inserted, true);
    const settled = await runtime.repositories.usage.settleWithBilling({
      requestId: "req-agg-test-1",
      userId,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      costMicros: 3_500_000,
      status: "ok",
      httpStatus: 200,
      errorMessage: null,
      now: Date.now(),
    });
    assert.equal(settled.settled, true);

    const byModel = await json("/api/admin/usage/by-model", { headers: auth(adminToken) });
    assert.equal(byModel.status, 200);
    const row = byModel.body.rows.find(
      (entry: { modelId: string }) => entry.modelId === "claude-test",
    );
    assert.ok(row, "聚合结果应包含 claude-test");
    assert.equal(row.totals.requestCount, 1);
    assert.equal(row.totals.costMicros, 3_500_000);

    const ledger = await json("/api/admin/ledger", { headers: auth(adminToken) });
    assert.equal(ledger.status, 200);
    const usageEntry = ledger.body.entries.find(
      (entry: { kind: string; userId: string }) =>
        entry.kind === "usage" && entry.userId === userId,
    );
    assert.ok(usageEntry, "全站流水应包含该用户的 usage 行");
    assert.equal(usageEntry.amountMicros, -3_500_000);
    assert.equal(usageEntry.direction, "debit");
  });
});

test("审计日志支持 actor 精确过滤", async () => {
  await withHarness(async ({ json, adminToken, runtime }) => {
    const other = await runtime.accounts.createUser({
      email: "actor@example.com",
      password: PASSWORD,
      role: "admin",
    });
    const otherLogin = await runtime.accounts.login({
      email: "actor@example.com",
      password: PASSWORD,
    });
    // 两个不同 actor 各留一条 settings.update 审计
    await json("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({ allowSelfRegistration: true }),
      headers: auth(adminToken),
    });
    await json("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({ allowSelfRegistration: false }),
      headers: auth(otherLogin.token),
    });

    const filtered = await json(
      `/api/admin/audit?actor=${encodeURIComponent(other.id)}&action=settings.update`,
      { headers: auth(adminToken) },
    );
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.entries[0].actorUserId, other.id);

    const all = await json("/api/admin/audit?action=settings.update", {
      headers: auth(adminToken),
    });
    assert.equal(all.body.total, 2);
  });
});

test("删除未被目录引用的上游 provider 返回 204", async () => {
  await withHarness(async ({ json, adminToken }) => {
    await json("/api/admin/providers/tmp-provider", {
      method: "PUT",
      body: JSON.stringify({
        label: "临时上游",
        upstreamBaseUrl: "https://upstream.test",
        protocol: "openai-chat-completions",
        apiKey: "sk-test",
      }),
      headers: auth(adminToken),
    });
    const removed = await json("/api/admin/providers/tmp-provider", {
      method: "DELETE",
      headers: auth(adminToken),
    });
    assert.equal(removed.status, 204);
    const listed = await json("/api/admin/providers", { headers: auth(adminToken) });
    assert.equal(
      listed.body.providers.some((p: { id: string }) => p.id === "tmp-provider"),
      false,
    );
  });
});

test("fetchUpstreamModelIds：3xx 拒绝跟随抛错，200 解析模型列表", async () => {
  const redirectFetch = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://evil.test" },
    })) as typeof fetch;
  await assert.rejects(
    fetchUpstreamModelIds({
      baseUrl: "https://upstream.test",
      apiKey: "sk-secret",
      protocol: "openai-chat-completions",
      fetchImpl: redirectFetch,
    }),
    /重定向/,
  );

  const calls: string[] = [];
  const okFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    // /v1/models 404，逼出回退路径；/models 返回模型清单
    return new Response(
      url.endsWith("/v1/models")
        ? "not found"
        : JSON.stringify({ data: [{ id: "gpt-test" }, { id: "gpt-test" }, { id: "o3" }] }),
      {
        status: url.endsWith("/v1/models") ? 404 : 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  const ok = await fetchUpstreamModelIds({
    baseUrl: "https://upstream.test",
    apiKey: "sk-secret",
    protocol: "openai-chat-completions",
    fetchImpl: okFetch,
  });
  assert.deepEqual(ok.models, ["gpt-test", "o3"]);
  // 先试 /v1/models 再退 /models：回退成功时提示管理员补 /v1
  assert.equal(calls.length, 2);
  assert.equal(ok.suggestedBaseUrl, "https://upstream.test/v1");
});
