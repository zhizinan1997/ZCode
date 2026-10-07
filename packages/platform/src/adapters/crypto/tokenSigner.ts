/**
 * 会话令牌签发与校验（HMAC-SHA256）。属于平台能力，只能放在 adapters 层。
 *
 * 格式：zct1.<base64url(claimsJson)>.<base64url(hmacSha256)>
 * 刻意不用 JWT：没有 algorithm 字段，就不存在算法混淆这一类问题；格式自带版本前缀，便于将来换算法。
 *
 * 签名密钥由部署方提供，缺失时拒绝构造——不允许用默认值兜底，否则任何人都能伪造令牌。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { PlatformError } from "../../domain/errors.js";
import type { TokenClaims } from "../../domain/token.js";

const TOKEN_PREFIX = "zct1";

export interface TokenSigner {
  sign(claims: TokenClaims): string;
  /** 校验签名与过期时间；失败抛 PlatformError。 */
  verify(token: string): TokenClaims;
}

function encodeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeSegment(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(payloadSegment: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadSegment).digest("base64url");
}

function parseClaims(raw: string): TokenClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const { sub, role, sid, iat, exp } = record;
  if (typeof sub !== "string" || !sub) return null;
  if (typeof role !== "string" || !role) return null;
  if (typeof sid !== "string" || !sid) return null;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  return { sub, role, sid, iat, exp };
}

export function createTokenSigner(secret: string): TokenSigner {
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new PlatformError("internal_error", "令牌签名密钥未配置（ZCODE_PLATFORM_TOKEN_SECRET）");
  }
  const key = trimmed;

  return {
    sign(claims) {
      const payloadSegment = encodeSegment(JSON.stringify(claims));
      return `${TOKEN_PREFIX}.${payloadSegment}.${signPayload(payloadSegment, key)}`;
    },

    verify(token) {
      const parts = token.split(".");
      if (parts.length !== 3) {
        throw new PlatformError("unauthorized", "令牌格式非法");
      }
      const [prefix, payloadSegment, signature] = parts as [string, string, string];
      if (prefix !== TOKEN_PREFIX) {
        throw new PlatformError("unauthorized", "令牌版本不受支持");
      }
      const expected = Buffer.from(signPayload(payloadSegment, key), "utf8");
      const actual = Buffer.from(signature, "utf8");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new PlatformError("unauthorized", "令牌签名无效");
      }
      const claims = parseClaims(decodeSegment(payloadSegment));
      if (!claims) {
        throw new PlatformError("unauthorized", "令牌载荷非法");
      }
      if (claims.exp * 1000 <= Date.now()) {
        throw new PlatformError("unauthorized", "令牌已过期");
      }
      return claims;
    },
  };
}
