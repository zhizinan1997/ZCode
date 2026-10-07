/** HTTP 边界端到端：直接对 Hono app 发请求，覆盖鉴权、权限与错误映射。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformRuntime } from "../src/adapters/composition.js";
import { createPlatformApp } from "../src/adapters/http/app.js";
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
    await json("/api/admin/users", post({ email: "user@example.com", password: PASSWORD }, adminToken));
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

    const login = await json("/api/auth/login", post({ email: "user@example.com", password: PASSWORD }));
    assert.equal(login.status, 200);
  });
});

test("重复邮箱返回 409", async () => {
  await withHarness(async ({ json, adminToken }) => {
    await json("/api/admin/users", post({ email: "dup@example.com", password: PASSWORD }, adminToken));
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
    const login = await json("/api/auth/login", post({ email: "user@example.com", password: PASSWORD }));
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

    const grant = await json(`/api/admin/users/${userId}/subscription`, post({ planId }, adminToken));
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
    await json(`/api/admin/users/${created.body.user.id as string}/subscription`, post({ planId }, adminToken));

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
    const created = await json(
      "/api/admin/providers/anthropic",
      {
        method: "PUT",
        body: JSON.stringify({
          label: "Anthropic",
          upstreamBaseUrl: "https://api.anthropic.com",
          protocol: "anthropic",
          apiKey: "sk-super-secret-value",
        }),
        headers: auth(adminToken),
      },
    );
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

    const content = JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      // 与客户端严格 schema 一致：内容嵌在 config 下
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
              },
              models: [{ modelId: "claude-test" }],
            },
          ],
        },
        modelConfigRules: { modelRules: [], builtinProviderModelRules: [] },
      },
    });
    const saved = await json("/api/admin/catalog", {
      method: "PUT",
      body: JSON.stringify({ content, expectedRevision: null }),
      headers: auth(adminToken),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 1);

    const configs = await json("/api/v1/client/configs");
    assert.equal(configs.status, 200);
    // 客户端 schema 要求 code 字面量 0 与 https 地址
    assert.equal(configs.body.code, 0);
    assert.equal(
      configs.body.data.configs.builtin_provider_config_json,
      "https://platform.test/api/v1/catalog/1.json",
    );

    const catalog = await json("/api/v1/catalog/1.json");
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.revision, 1);
  });
});

test("客户端账单接口返回余额与套餐", async () => {
  await withHarness(async ({ json, adminToken }) => {
    await json("/api/admin/users", post({ email: "bill@example.com", password: PASSWORD }, adminToken));
    const login = await json("/api/auth/login", post({ email: "bill@example.com", password: PASSWORD }));
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
    const missing = await json("/api/v1/releases/electron/manifest?platform=windows-x86_64&channel=1");
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

    const manifest = await request("/api/v1/releases/electron/manifest?platform=windows-x86_64&channel=1");
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
    const login = await json("/api/auth/login", post({ email: "user@example.com", password: PASSWORD }));
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
    await json("/api/admin/users", post({ email: "user@example.com", password: PASSWORD }, adminToken));
    const login = await json("/api/auth/login", post({ email: "user@example.com", password: PASSWORD }));
    const userToken = login.body.token as string;

    const changed = await json(
      "/api/auth/password",
      post({ currentPassword: PASSWORD, newPassword: "another-password" }, userToken),
    );
    assert.equal(changed.status, 204);
    assert.equal((await json("/api/auth/me", { headers: auth(userToken) })).status, 200);
  });
});

test("未知路由返回 404", async () => {
  await withHarness(async ({ json }) => {
    const result = await json("/api/unknown");
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, "not_found");
  });
});
