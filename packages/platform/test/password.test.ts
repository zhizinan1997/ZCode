import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword,
  needsPasswordRehash,
  verifyPassword,
} from "../src/adapters/crypto/passwordHash.js";
import { validatePasswordStrength } from "../src/domain/passwordPolicy.js";

test("哈希与校验往返一致", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("correct horse battery", stored), true);
  assert.equal(await verifyPassword("wrong password", stored), false);
});

test("同一密码两次哈希结果不同（盐随机）", async () => {
  const first = await hashPassword("same-password");
  const second = await hashPassword("same-password");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("same-password", first), true);
  assert.equal(await verifyPassword("same-password", second), true);
});

test("存储格式为 scrypt$N$r$p$salt$hash", async () => {
  const stored = await hashPassword("another-password");
  const parts = stored.split("$");
  assert.equal(parts.length, 6);
  assert.equal(parts[0], "scrypt");
  assert.equal(parts[1], "16384");
  assert.equal(parts[2], "8");
  assert.equal(parts[3], "1");
});

test("损坏的存储值一律判定失败，不抛异常", async () => {
  for (const broken of [
    "",
    "not-a-hash",
    "scrypt$16384$8$1$onlyfive",
    // 旧式 tag 写法，不是真实 bcrypt 记录（真实记录形如 $2b$10$...）
    "bcrypt$16384$8$1$c2FsdA==$aGFzaA==",
    "scrypt$x$8$1$c2FsdA==$aGFzaA==",
    "scrypt$16384$8$1$$",
    // 无法解析的 bcrypt 记录：bcryptjs 对未知 revision 会抛错，这里必须收敛成 false
    `$2x$10$${"a".repeat(53)}`,
  ]) {
    assert.equal(await verifyPassword("anything", broken), false);
  }
});

/**
 * 历史 bcrypt 向量，由 python-bcrypt 5.0.0（OpenBSD crypt_blowfish 派生实现）生成并用
 * 该实现独立回验。用固定向量而不是现场用本仓库的函数生成，才能证明我们认的是真实历史
 * 记录；`$2y$` 那条是 PHP password_hash 的等价前缀写法（同一 salt/hash 换前缀）。
 */
const BCRYPT_VECTORS = [
  {
    revision: "$2b$",
    plain: "correct horse battery",
    hash: "$2b$10$ac4qgcU996ayGW1Ncy8FnuZ7Jy4iygttwnaC4P1xq5XnmY9ZI3MLS",
  },
  {
    revision: "$2a$",
    plain: "12345678",
    hash: "$2a$10$gKXpVCcp/HwHSOGkzVyzc.B0A6idjQ67R0GFWi1Oi2wo60TSshSTu",
  },
  {
    revision: "$2a$",
    plain: "legacy",
    hash: "$2a$10$sZU/zzTOR8lHSktnZ3K18.CQrlMAktPPRnCSQQ.YuxUSXcUUsf/RC",
  },
  {
    revision: "$2y$",
    plain: "P@ssw0rd-legacy",
    hash: "$2y$10$zCGFsVuzY4q.w7sF2fFksOGUJkHAenRhKtiabowqOgi2ZvWpFpeGG",
  },
  {
    // 与存量数据的实际形状一致（2026-10-07 线上巡检：65 条 bcrypt 记录全是 $2b$ + cost 12）。
    revision: "$2b$",
    plain: "short",
    hash: "$2b$12$eAiES544Zr/byhgAKP/96u7ZKCLegAvDbGussjJY0NI8zbuEoZeQe",
  },
] as const;

test("历史 bcrypt 记录：2a/2b/2y 都能校验，密码错误判失败", async () => {
  for (const { revision, plain, hash } of BCRYPT_VECTORS) {
    // 改首字符而不是追加后缀：bcrypt 只取前 72 字节，追加的内容对长密码不可见。
    const wrong = `Z${plain.slice(1)}`;
    assert.equal(await verifyPassword(plain, hash), true, `${revision} 正确密码应通过`);
    assert.equal(await verifyPassword(wrong, hash), false, `${revision} 错误密码应失败`);
  }
});

test("bcrypt 记录不因密码不满足现行强度策略而无法校验", async () => {
  const legacy = BCRYPT_VECTORS[2];
  // 写入路径的策略只约束 hashPassword；校验历史密码必须与它无关，
  // 否则迁移过来的短密码用户会被永久挡在门外。
  assert.equal(validatePasswordStrength(legacy.plain), "密码至少 8 位");
  assert.equal(await verifyPassword(legacy.plain, legacy.hash), true);
});

test("bcrypt 的 72 字节截断语义与历史实现一致", async () => {
  const hash = "$2b$10$O9pWAuWhlGKZj9FzHgF8leW2a3f8hVF3N7ERT.hYNZuzboS5eVT8q";
  assert.equal(await verifyPassword("x".repeat(100), hash), true);
  assert.equal(await verifyPassword("x".repeat(72), hash), true);
  // 第 72 字节之后的内容对 bcrypt 不可见——格式固有语义，不是缺陷
  assert.equal(await verifyPassword(`${"x".repeat(72)}totally-other-tail`, hash), true);
  assert.equal(await verifyPassword(`Z${"x".repeat(71)}`, hash), false);
});

test("needsPasswordRehash：只对可识别的历史 bcrypt 记录为真", async () => {
  for (const { hash } of BCRYPT_VECTORS) {
    assert.equal(needsPasswordRehash(hash), true, hash);
  }
  assert.equal(needsPasswordRehash(await hashPassword("correct horse battery")), false);
  for (const other of [
    "",
    "not-a-hash",
    "bcrypt$16384$8$1$c2FsdA==$aGFzaA==",
    `$2x$10$${"a".repeat(53)}`, // 未修复的旧实现
    `$2b$03$${"a".repeat(53)}`, // cost 低于 bcrypt 合法下限
    `$2b$31$${"a".repeat(53)}`, // cost 超出上限，见下面的挂起防护
    `$2a$10$${"a".repeat(52)}`, // 长度不足
  ]) {
    assert.equal(needsPasswordRehash(other), false, other);
  }
});

test("超出 cost 上限的记录立即判失败，不执行 2^cost 次派生", async () => {
  // cost 来自存储记录而非调用方：cost 31 在纯 JS 实现下约合 2.5 天，
  // 这条用例的 1 秒预算就是防止它退化成把登录请求挂死。
  const started = Date.now();
  assert.equal(await verifyPassword("anything", `$2b$31$${"a".repeat(53)}`), false);
  assert.ok(Date.now() - started < 1000, "超出上限的 cost 不应真的执行派生");
});

test("强度校验：过短或过长都拒绝", () => {
  assert.equal(validatePasswordStrength("short"), "密码至少 8 位");
  assert.equal(validatePasswordStrength("12345678"), null);
  assert.equal(validatePasswordStrength("x".repeat(201)), "密码最多 200 位");
});

test("哈希入口同样执行强度校验", async () => {
  await assert.rejects(() => hashPassword("short"), /至少 8 位/);
});
