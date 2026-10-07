import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/adapters/crypto/passwordHash.js";
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
    "bcrypt$16384$8$1$c2FsdA==$aGFzaA==",
    "scrypt$x$8$1$c2FsdA==$aGFzaA==",
    "scrypt$16384$8$1$$",
  ]) {
    assert.equal(await verifyPassword("anything", broken), false);
  }
});

test("强度校验：过短或过长都拒绝", () => {
  assert.equal(validatePasswordStrength("short"), "密码至少 8 位");
  assert.equal(validatePasswordStrength("12345678"), null);
  assert.equal(validatePasswordStrength("x".repeat(201)), "密码最多 200 位");
});

test("哈希入口同样执行强度校验", async () => {
  await assert.rejects(() => hashPassword("short"), /至少 8 位/);
});
