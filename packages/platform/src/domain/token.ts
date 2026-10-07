/**
 * 会话令牌的形状与文本规则（纯逻辑）。
 *
 * 签名与校验的实现在 adapters/crypto/tokenSigner.ts：HMAC 属于平台能力，
 * domain 层不得依赖 node: 内置模块。
 */

export interface TokenClaims {
  /** 用户 id。 */
  readonly sub: string;
  readonly role: string;
  /** 会话 id；登出与撤销以会话为单位。 */
  readonly sid: string;
  /** 签发时间（秒）。 */
  readonly iat: number;
  /** 过期时间（秒）。 */
  readonly exp: number;
}

/** 从 Authorization 头解析 Bearer 令牌；缺失或格式不对返回 null。 */
export function readBearerToken(headerValue: string | undefined | null): string | null {
  if (!headerValue) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}
