/**
 * 运营域类型：审计日志、系统设置、兑换码、用户 API Key（纯逻辑）。
 * 形状与约束见 specs/platform/operations.md。
 */

export interface AuditLogEntry {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly detail: string | null;
  readonly createdAt: number;
}

export interface AuditAppend {
  readonly actorUserId: string | null;
  readonly action: string;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly detail?: string | null;
  readonly now: number;
}

export type SettingValue = string;

/** 系统设置键与其形状；service 层据此做读取归一化与写入校验。 */
export const SETTING_KEYS = {
  forceUpdateMinimalVersion: "forceUpdateMinimalVersion",
  allowSelfRegistration: "allowSelfRegistration",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/** 管理端读到的设置视图（字符串原样；布尔语义由读取方归一化）。 */
export interface SystemSettingsView {
  readonly forceUpdateMinimalVersion: string;
  readonly allowSelfRegistration: boolean;
}

export interface RedeemCodeRecord {
  readonly id: string;
  readonly code: string;
  readonly amountMicros: number;
  readonly maxRedemptions: number;
  readonly redeemedCount: number;
  readonly expiresAt: number | null;
  readonly createdBy: string | null;
  readonly revokedAt: number | null;
  readonly createdAt: number;
}

export interface RedeemRedemptionRecord {
  readonly id: string;
  readonly codeId: string;
  readonly userId: string;
  readonly amountMicros: number;
  readonly redeemedAt: number;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly userId: string;
  /** scrypt 派生值，格式与用户密码哈希一致；绝不出现在任何响应里。 */
  readonly keyHash: string;
  readonly keyHint: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

/** 兑换码核销结果。 */
export interface RedeemResult {
  readonly amountMicros: number;
}

/** 核销失败的稳定原因。 */
export type RedeemRejection =
  | "not_found"
  | "revoked"
  | "expired"
  | "exhausted"
  | "already_redeemed";

export function isRedeemRejection(value: unknown): value is RedeemRejection {
  return (
    value === "not_found" ||
    value === "revoked" ||
    value === "expired" ||
    value === "exhausted" ||
    value === "already_redeemed"
  );
}
