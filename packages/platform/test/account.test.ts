import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformRuntime } from "../src/adapters/composition.js";
import { PlatformError } from "../src/domain/errors.js";
import { createTestRuntime } from "./helpers.js";

async function withRuntime(run: (runtime: PlatformRuntime) => Promise<void>): Promise<void> {
  const runtime = await createTestRuntime();
  try {
    await run(runtime);
  } finally {
    runtime.dispose();
  }
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof PlatformError, `期望 PlatformError，实际 ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

const PASSWORD = "initial-password";

test("管理员建号后用户可登录", async () => {
  await withRuntime(async ({ accounts }) => {
    const created = await accounts.createUser({ email: "user@example.com", password: PASSWORD });
    assert.equal(created.role, "user");
    assert.equal(created.status, "active");

    const login = await accounts.login({ email: "user@example.com", password: PASSWORD });
    assert.ok(login.token.length > 0);
    assert.ok(login.expiresAt > Date.now());
    assert.equal(login.user.email, "user@example.com");
  });
});

test("邮箱大小写与空格被规范化，重复注册被拒", async () => {
  await withRuntime(async ({ accounts }) => {
    await accounts.createUser({ email: "  Foo@Example.COM ", password: PASSWORD });
    await assert.rejects(
      () => accounts.createUser({ email: "foo@example.com", password: PASSWORD }),
      expectCode("user_exists"),
    );
    // 用任意写法都能登录到同一个账号
    await accounts.login({ email: "FOO@example.com", password: PASSWORD });
  });
});

test("邮箱格式非法与密码过短被拒", async () => {
  await withRuntime(async ({ accounts }) => {
    await assert.rejects(
      () => accounts.createUser({ email: "not-an-email", password: PASSWORD }),
      expectCode("invalid_request"),
    );
    await assert.rejects(
      () => accounts.createUser({ email: "ok@example.com", password: "short" }),
      expectCode("invalid_request"),
    );
  });
});

test("密码错误与账号不存在返回同一个错误码（不泄露账号是否存在）", async () => {
  await withRuntime(async ({ accounts }) => {
    await accounts.createUser({ email: "known@example.com", password: PASSWORD });
    let wrongPassword: PlatformError | null = null;
    try {
      await accounts.login({ email: "known@example.com", password: "wrong-password" });
    } catch (error) {
      wrongPassword = error as PlatformError;
    }
    let unknownEmail: PlatformError | null = null;
    try {
      await accounts.login({ email: "unknown@example.com", password: PASSWORD });
    } catch (error) {
      unknownEmail = error as PlatformError;
    }
    assert.ok(wrongPassword && unknownEmail);
    assert.equal(wrongPassword.code, "invalid_credentials");
    assert.equal(unknownEmail.code, "invalid_credentials");
    assert.equal(wrongPassword.message, unknownEmail.message);
  });
});

test("登出后令牌立即失效", async () => {
  await withRuntime(async ({ accounts }) => {
    await accounts.createUser({ email: "user@example.com", password: PASSWORD });
    const login = await accounts.login({ email: "user@example.com", password: PASSWORD });
    const before = await accounts.authenticate(login.token);
    assert.equal(before.session.revokedAt, null);

    await accounts.logout(before.session.id);
    await assert.rejects(() => accounts.authenticate(login.token), expectCode("session_revoked"));
  });
});

test("篡改令牌无法通过鉴权", async () => {
  await withRuntime(async ({ accounts }) => {
    await accounts.createUser({ email: "user@example.com", password: PASSWORD });
    const login = await accounts.login({ email: "user@example.com", password: PASSWORD });
    const tampered = `${login.token}tampered`;
    await assert.rejects(() => accounts.authenticate(tampered), expectCode("unauthorized"));
  });
});

test("停用用户会立刻撤销其会话且不能再登录", async () => {
  await withRuntime(async ({ accounts }) => {
    const created = await accounts.createUser({ email: "user@example.com", password: PASSWORD });
    const login = await accounts.login({ email: "user@example.com", password: PASSWORD });

    await accounts.setUserStatus({ userId: created.id, status: "disabled" });

    // 已签发的令牌立刻失效（会话被撤销）
    await assert.rejects(() => accounts.authenticate(login.token), expectCode("session_revoked"));
    // 也不能重新登录
    await assert.rejects(
      () => accounts.login({ email: "user@example.com", password: PASSWORD }),
      expectCode("invalid_credentials"),
    );

    await accounts.setUserStatus({ userId: created.id, status: "active" });
    await accounts.login({ email: "user@example.com", password: PASSWORD });
  });
});

test("管理员重置密码会踢掉该用户全部会话", async () => {
  await withRuntime(async ({ accounts }) => {
    const created = await accounts.createUser({ email: "user@example.com", password: PASSWORD });
    const login = await accounts.login({ email: "user@example.com", password: PASSWORD });

    await accounts.resetPassword(created.id, "brand-new-password");

    await assert.rejects(() => accounts.authenticate(login.token), expectCode("session_revoked"));
    await assert.rejects(
      () => accounts.login({ email: "user@example.com", password: PASSWORD }),
      expectCode("invalid_credentials"),
    );
    await accounts.login({ email: "user@example.com", password: "brand-new-password" });
  });
});

test("用户改密：原密码错误被拒，成功后保留当前会话、踢掉其它会话", async () => {
  await withRuntime(async ({ accounts }) => {
    await accounts.createUser({ email: "user@example.com", password: PASSWORD });
    const first = await accounts.login({ email: "user@example.com", password: PASSWORD });
    const second = await accounts.login({ email: "user@example.com", password: PASSWORD });
    const firstSession = await accounts.authenticate(first.token);

    await assert.rejects(
      () =>
        accounts.changePassword({
          userId: firstSession.user.id,
          currentPassword: "wrong-password",
          newPassword: "another-password",
          keepSessionId: firstSession.session.id,
        }),
      expectCode("invalid_credentials"),
    );

    await accounts.changePassword({
      userId: firstSession.user.id,
      currentPassword: PASSWORD,
      newPassword: "another-password",
      keepSessionId: firstSession.session.id,
    });

    // 当前会话保留
    await accounts.authenticate(first.token);
    // 其它会话被撤销
    await assert.rejects(() => accounts.authenticate(second.token), expectCode("session_revoked"));
    // 新密码可用，旧密码不可用
    await accounts.login({ email: "user@example.com", password: "another-password" });
    await assert.rejects(
      () => accounts.login({ email: "user@example.com", password: PASSWORD }),
      expectCode("invalid_credentials"),
    );
  });
});

test("角色变更生效，非管理员不具备管理员身份", async () => {
  await withRuntime(async ({ accounts }) => {
    const created = await accounts.createUser({ email: "user@example.com", password: PASSWORD });
    assert.equal(created.role, "user");
    const promoted = await accounts.setUserRole(created.id, "admin");
    assert.equal(promoted.role, "admin");
    // 角色变化不影响已有会话可用性，但下次鉴权读到的是新角色
    const login = await accounts.login({ email: "user@example.com", password: PASSWORD });
    const context = await accounts.authenticate(login.token);
    assert.equal(context.user.role, "admin");
  });
});

test("hasAdmin 正确反映是否存在管理员", async () => {
  await withRuntime(async ({ accounts }) => {
    assert.equal(await accounts.hasAdmin(), false);
    await accounts.createUser({ email: "user@example.com", password: PASSWORD });
    assert.equal(await accounts.hasAdmin(), false);
    await accounts.createUser({ email: "admin@example.com", password: PASSWORD, role: "admin" });
    assert.equal(await accounts.hasAdmin(), true);
  });
});

test("用户列表分页与总数", async () => {
  await withRuntime(async ({ accounts }) => {
    for (let index = 0; index < 5; index += 1) {
      await accounts.createUser({ email: `user${index}@example.com`, password: PASSWORD });
    }
    const page = await accounts.listUsers({ limit: 2, offset: 1 });
    assert.equal(page.total, 5);
    assert.equal(page.users.length, 2);
    assert.equal(page.users[0]?.email, "user1@example.com");
  });
});

test("未知用户的操作返回 user_not_found", async () => {
  await withRuntime(async ({ accounts }) => {
    await assert.rejects(() => accounts.getUser("usr_missing"), expectCode("user_not_found"));
    await assert.rejects(
      () => accounts.setUserStatus({ userId: "usr_missing", status: "disabled" }),
      expectCode("user_not_found"),
    );
    await assert.rejects(
      () => accounts.resetPassword("usr_missing", PASSWORD),
      expectCode("user_not_found"),
    );
  });
});

test("令牌过期后鉴权失败", async () => {
  // 令牌 exp 与会话 expiresAt 同源，且校验顺序是先验令牌，所以到点后先命中 unauthorized。
  const runtime = await createTestRuntime({ sessionTtlMs: 1 });
  try {
    await runtime.accounts.createUser({ email: "user@example.com", password: PASSWORD });
    const login = await runtime.accounts.login({ email: "user@example.com", password: PASSWORD });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await assert.rejects(
      () => runtime.accounts.authenticate(login.token),
      expectCode("unauthorized"),
    );
  } finally {
    runtime.dispose();
  }
});

/**
 * 历史 bcrypt 记录：迁移过来的用户 password_hash 就是这种值。
 * 向量与 password.test.ts 同源，由 python-bcrypt 5.0.0 生成。
 */
const LEGACY_HASH = "$2a$10$gKXpVCcp/HwHSOGkzVyzc.B0A6idjQ67R0GFWi1Oi2wo60TSshSTu";
const LEGACY_PASSWORD = "12345678";
/** 同一来源，但明文只有 6 位：不满足现行强度策略，用来验证升级不阻断登录。 */
const LEGACY_WEAK_HASH = "$2a$10$sZU/zzTOR8lHSktnZ3K18.CQrlMAktPPRnCSQQ.YuxUSXcUUsf/RC";
const LEGACY_WEAK_PASSWORD = "legacy";

/** 把已建用户的哈希改写成历史 bcrypt 记录，模拟迁移数据。 */
async function seedLegacyHash(
  runtime: PlatformRuntime,
  userId: string,
  passwordHash: string,
): Promise<void> {
  const user = await runtime.repositories.users.findById(userId);
  assert.ok(user, "测试用户应已存在");
  await runtime.repositories.users.update({ ...user, passwordHash, updatedAt: Date.now() });
}

async function readPasswordHash(runtime: PlatformRuntime, userId: string): Promise<string> {
  const user = await runtime.repositories.users.findById(userId);
  assert.ok(user, "测试用户应已存在");
  return user.passwordHash;
}

test("历史 bcrypt 记录能登录，并在登录成功后无感升级为 scrypt", async () => {
  await withRuntime(async (runtime) => {
    const created = await runtime.accounts.createUser({
      email: "legacy@example.com",
      password: PASSWORD,
    });
    await seedLegacyHash(runtime, created.id, LEGACY_HASH);

    const login = await runtime.accounts.login({
      email: "legacy@example.com",
      password: LEGACY_PASSWORD,
    });
    assert.equal(login.user.email, "legacy@example.com");
    assert.match(await readPasswordHash(runtime, created.id), /^scrypt\$/);

    // 升级后的记录仍认同一个密码
    await runtime.accounts.login({ email: "legacy@example.com", password: LEGACY_PASSWORD });
  });
});

test("历史 bcrypt 记录 + 不满足现行策略的旧密码：能登录，记录保持 bcrypt", async () => {
  await withRuntime(async (runtime) => {
    const created = await runtime.accounts.createUser({
      email: "weak@example.com",
      password: PASSWORD,
    });
    await seedLegacyHash(runtime, created.id, LEGACY_WEAK_HASH);

    // 升级要写入 scrypt，而写入路径统一执行强度校验；短密码因此不升级，
    // 但登录本身必须照常成功，否则迁移过来的老用户会被永久挡在门外。
    await runtime.accounts.login({ email: "weak@example.com", password: LEGACY_WEAK_PASSWORD });
    assert.equal(await readPasswordHash(runtime, created.id), LEGACY_WEAK_HASH);
  });
});

test("bcrypt 记录密码错误：登录失败且不改写记录", async () => {
  await withRuntime(async (runtime) => {
    const created = await runtime.accounts.createUser({
      email: "legacy@example.com",
      password: PASSWORD,
    });
    await seedLegacyHash(runtime, created.id, LEGACY_HASH);

    await assert.rejects(
      () => runtime.accounts.login({ email: "legacy@example.com", password: "wrong-password" }),
      expectCode("invalid_credentials"),
    );
    assert.equal(await readPasswordHash(runtime, created.id), LEGACY_HASH);
  });
});

test("停用的 bcrypt 用户在状态检查处被拒，记录不被升级", async () => {
  await withRuntime(async (runtime) => {
    const created = await runtime.accounts.createUser({
      email: "legacy@example.com",
      password: PASSWORD,
    });
    await seedLegacyHash(runtime, created.id, LEGACY_HASH);
    await runtime.accounts.setUserStatus({ userId: created.id, status: "disabled" });

    // 校验顺序是"先验密码、再看状态"，升级排在状态检查之后，
    // 因此停用用户不会因为一次失败的登录尝试被改写哈希。
    await assert.rejects(
      () => runtime.accounts.login({ email: "legacy@example.com", password: LEGACY_PASSWORD }),
      expectCode("invalid_credentials"),
    );
    assert.equal(await readPasswordHash(runtime, created.id), LEGACY_HASH);
  });
});

test("bcrypt 用户改密后记录直接变为 scrypt", async () => {
  await withRuntime(async (runtime) => {
    const created = await runtime.accounts.createUser({
      email: "legacy@example.com",
      password: PASSWORD,
    });
    await seedLegacyHash(runtime, created.id, LEGACY_HASH);
    const login = await runtime.accounts.login({
      email: "legacy@example.com",
      password: LEGACY_PASSWORD,
    });
    const session = await runtime.accounts.authenticate(login.token);

    // 改密本来就走 hashPassword，不需要为 bcrypt 单开升级分支
    await runtime.accounts.changePassword({
      userId: created.id,
      currentPassword: LEGACY_PASSWORD,
      newPassword: "brand-new-password",
      keepSessionId: session.session.id,
    });
    assert.match(await readPasswordHash(runtime, created.id), /^scrypt\$/);
    await runtime.accounts.login({
      email: "legacy@example.com",
      password: "brand-new-password",
    });
  });
});
