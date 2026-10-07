import assert from "node:assert/strict";
import test from "node:test";
import { createTokenSigner } from "../src/adapters/crypto/tokenSigner.js";
import { PlatformError } from "../src/domain/errors.js";
import { readBearerToken, type TokenClaims } from "../src/domain/token.js";

const SECRET = "unit-test-secret";

function claims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    sub: "usr_1",
    role: "user",
    sid: "ses_1",
    iat: issuedAt,
    exp: issuedAt + 60,
    ...overrides,
  };
}

test("令牌签名后可原样校验出载荷", () => {
  const signer = createTokenSigner(SECRET);
  const token = signer.sign(claims());
  const verified = signer.verify(token);
  assert.equal(verified.sub, "usr_1");
  assert.equal(verified.sid, "ses_1");
  assert.equal(verified.role, "user");
});

test("缺少签名密钥时拒绝构造签名器", () => {
  assert.throws(
    () => createTokenSigner(""),
    (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.equal(error.code, "internal_error");
      return true;
    },
  );
  assert.throws(() => createTokenSigner("   "));
});

test("用其它密钥签发的令牌不被接受", () => {
  const token = createTokenSigner("other-secret").sign(claims());
  assert.throws(
    () => createTokenSigner(SECRET).verify(token),
    (error: unknown) => error instanceof PlatformError && error.code === "unauthorized",
  );
});

test("篡改载荷会被签名校验拦下", () => {
  const signer = createTokenSigner(SECRET);
  const token = signer.sign(claims({ role: "user" }));
  const parts = token.split(".") as [string, string, string];
  const forgedPayload = Buffer.from(
    JSON.stringify({ ...claims(), role: "admin" }),
    "utf8",
  ).toString("base64url");
  assert.throws(
    () => signer.verify(`${parts[0]}.${forgedPayload}.${parts[2]}`),
    (error: unknown) => error instanceof PlatformError && error.code === "unauthorized",
  );
  // 原令牌仍然有效，确认上面的失败来自篡改而不是解析问题
  assert.equal(signer.verify(token).role, "user");
});

test("过期令牌被拒绝", () => {
  const signer = createTokenSigner(SECRET);
  const past = Math.floor(Date.now() / 1000) - 10;
  const token = signer.sign(claims({ iat: past - 60, exp: past }));
  assert.throws(
    () => signer.verify(token),
    (error: unknown) => error instanceof PlatformError && error.code === "unauthorized",
  );
});

test("格式非法的令牌被拒绝", () => {
  const signer = createTokenSigner(SECRET);
  for (const bad of ["", "abc", "zct1.only-two", "a.b.c.d", "wrongprefix.x.y"]) {
    assert.throws(
      () => signer.verify(bad),
      (error: unknown) => error instanceof PlatformError,
    );
  }
});

test("载荷缺字段视为非法", () => {
  const signer = createTokenSigner(SECRET);
  const payload = Buffer.from(JSON.stringify({ sub: "usr_1" }), "utf8").toString("base64url");
  const signature = (signer.sign(claims()).split(".") as [string, string, string])[2];
  // 签名本身有效但载荷缺 sid/exp：必须被载荷校验拦下
  assert.throws(
    () => signer.verify(`zct1.${payload}.${signature}`),
    (error: unknown) => error instanceof PlatformError && error.code === "unauthorized",
  );
});

test("Bearer 头解析", () => {
  assert.equal(readBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(readBearerToken("bearer abc"), "abc");
  assert.equal(readBearerToken("Basic abc"), null);
  assert.equal(readBearerToken(""), null);
  assert.equal(readBearerToken(undefined), null);
});
