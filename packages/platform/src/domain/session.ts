/**
 * 登录会话领域类型。
 *
 * 令牌本身是无状态签名的，但会话必须落库：只有这样才能做登出即失效与管理员强制下线，
 * 否则签出去的令牌在过期前无法撤销。
 */

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  /** epoch 毫秒。 */
  readonly createdAt: number;
  /** epoch 毫秒。 */
  readonly expiresAt: number;
  /** epoch 毫秒；非空表示已撤销（登出或强制下线）。 */
  readonly revokedAt: number | null;
  readonly userAgent: string | null;
}

export function isSessionUsable(session: SessionRecord, now: number): boolean {
  return session.revokedAt === null && session.expiresAt > now;
}
