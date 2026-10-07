/**
 * 运营用例：系统设置、审计、兑换码、用户 API Key。
 *
 * 约束（specs/platform/operations.md）：
 * - 审计是旁路观察者：记录失败只打 warn，不让业务操作失败。
 * - 兑换码核销的事务判定在仓储层，service 只做编排与 ledger 记账。
 * - API Key 明文只在创建时返回一次，之后只能看到 hint。
 */
import { randomBytes } from "node:crypto";
import { PlatformError } from "../domain/errors.js";
import type { Micros } from "../domain/money.js";
import { formatMicros, microsFromDecimalString } from "../domain/money.js";
import type {
  ApiKeyRecord,
  AuditAppend,
  AuditLogEntry,
  RedeemCodeRecord,
  SystemSettingsView,
} from "../domain/operations.js";
import { SETTING_KEYS } from "../domain/operations.js";
import type {
  ApiKeyRepository,
  AuditRepository,
  BillingRepository,
  RedeemRepository,
  SettingsRepository,
  UserRepository,
} from "./ports.js";

/** app 层只需要写 warn 的能力；完整日志器由 adapters 提供。 */
interface OperationsLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export type { SystemSettingsView };

/**
 * 依赖注入：hashApiKey/verifyApiKey 与用户密码哈希复用同一对函数，由 adapters 提供。
 * 写入恒为 scrypt；校验兼容历史 bcrypt 记录，但 API Key 只由 hashApiKey 写入，
 * 那条分支对它不可达。
 */
export interface OperationsServiceDeps {
  readonly audit: AuditRepository;
  readonly settings: SettingsRepository;
  readonly redeems: RedeemRepository;
  readonly apiKeys: ApiKeyRepository;
  readonly billing: BillingRepository;
  readonly users: UserRepository;
  readonly now: () => number;
  readonly logger: OperationsLogger;
  readonly hashApiKey: (plain: string) => Promise<string>;
  readonly verifyApiKey: (plain: string, stored: string) => Promise<boolean>;
  readonly newRedeemCodeId: () => string;
  readonly newApiKeyId: () => string;
}

export interface OperationsService {
  // ── 审计 ────────────────────────────────────────────────
  /** 旁路记录：内部捕获所有异常，只打 warn。 */
  record(entry: AuditAppend): void;
  listAudit(options: {
    action?: string;
    /** 按操作者 userId 精确过滤；管理后台审计页按人筛选时使用。 */
    actor?: string;
    limit: number;
    offset: number;
  }): Promise<{ entries: AuditLogEntry[]; total: number }>;

  // ── 设置 ────────────────────────────────────────────────
  getSettings(): Promise<SystemSettingsView>;
  updateSettings(input: {
    forceUpdateMinimalVersion?: string;
    allowSelfRegistration?: boolean;
    updatedBy: string | null;
  }): Promise<SystemSettingsView>;

  // ── 兑换码 ──────────────────────────────────────────────
  createRedeemCodes(input: {
    count: number;
    amount: string;
    maxRedemptions: number;
    expiresAt: number | null;
    createdBy: string | null;
  }): Promise<RedeemCodeRecord[]>;
  listRedeemCodes(): Promise<RedeemCodeRecord[]>;
  revokeRedeemCode(input: { codeId: string; actorUserId: string | null }): Promise<void>;
  /** 用户核销：成功后入账并写审计；拒绝时抛 invalid_request，message 面向用户。 */
  redeemCode(input: { userId: string; code: string }): Promise<{ amountMicros: Micros }>;

  // ── 用户 API Key ────────────────────────────────────────
  createApiKey(input: {
    userId: string;
    name: string;
    actorUserId: string | null;
  }): Promise<{ record: ApiKeyRecord; plaintext: string }>;
  listApiKeysForUser(userId: string): Promise<ApiKeyRecord[]>;
  listAllApiKeys(): Promise<ApiKeyRecord[]>;
  revokeApiKey(input: { keyId: string; actorUserId: string | null }): Promise<void>;
  /** 网关鉴权：成功返回用户 id；失败返回 null（调用方负责 401 与审计）。 */
  authenticateApiKey(plaintext: string): Promise<string | null>;
}

const REDEEM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REDEEM_CODE_LENGTH = 16;
const API_KEY_PREFIX = "zcpk_";
const API_KEY_RANDOM_BYTES = 24;
const MAX_CODES_PER_BATCH = 50;

/** 人类可读的兑换码：4 字符一组、连字符分隔，字母表去掉了易混淆的 I/O/0/1。 */
function generateRedeemCode(): string {
  const bytes = randomBytes(REDEEM_CODE_LENGTH);
  const chars = [...bytes].map((byte) => REDEEM_CODE_ALPHABET[byte % REDEEM_CODE_ALPHABET.length]);
  const groups: string[] = [];
  for (let index = 0; index < chars.length; index += 4) {
    groups.push(chars.slice(index, index + 4).join(""));
  }
  return groups.join("-");
}

function generateApiKeyPlaintext(): string {
  return API_KEY_PREFIX + randomBytes(API_KEY_RANDOM_BYTES).toString("base64url");
}

function apiKeyHint(plaintext: string): string {
  return `…${plaintext.slice(-4)}`;
}

function validateVersionFormat(version: string): boolean {
  return /^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.-]+)?$/.test(version);
}

export function createOperationsService(deps: OperationsServiceDeps): OperationsService {
  const record = (entry: AuditAppend): void => {
    // 审计失败绝不能打断业务操作：这里把所有异常吞掉并降级为 warn 日志。
    deps.audit.append(entry).catch((error: unknown) => {
      deps.logger.warn("审计日志写入失败", {
        action: entry.action,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  async function readSettingsView(): Promise<SystemSettingsView> {
    const stored = await deps.settings.readAll();
    const rawMinimal = stored.get(SETTING_KEYS.forceUpdateMinimalVersion) ?? "";
    const rawAllow = stored.get(SETTING_KEYS.allowSelfRegistration) ?? "false";
    return {
      forceUpdateMinimalVersion: rawMinimal,
      allowSelfRegistration: rawAllow === "true",
    };
  }

  return {
    record,

    async listAudit(options) {
      return await deps.audit.list(options);
    },

    async getSettings() {
      return await readSettingsView();
    },

    async updateSettings(input) {
      if (input.forceUpdateMinimalVersion !== undefined) {
        const version = input.forceUpdateMinimalVersion.trim();
        if (version && !validateVersionFormat(version)) {
          throw new PlatformError("invalid_request", `最低可用版本格式不正确：${version}`);
        }
        await deps.settings.write(
          SETTING_KEYS.forceUpdateMinimalVersion,
          version,
          input.updatedBy,
          deps.now(),
        );
        record({
          actorUserId: input.updatedBy,
          action: "settings.update",
          targetType: "setting",
          targetId: SETTING_KEYS.forceUpdateMinimalVersion,
          detail: JSON.stringify({ value: version }),
          now: deps.now(),
        });
      }
      if (input.allowSelfRegistration !== undefined) {
        await deps.settings.write(
          SETTING_KEYS.allowSelfRegistration,
          input.allowSelfRegistration ? "true" : "false",
          input.updatedBy,
          deps.now(),
        );
        record({
          actorUserId: input.updatedBy,
          action: "settings.update",
          targetType: "setting",
          targetId: SETTING_KEYS.allowSelfRegistration,
          detail: JSON.stringify({ value: input.allowSelfRegistration }),
          now: deps.now(),
        });
      }
      return await readSettingsView();
    },

    async createRedeemCodes(input) {
      if (
        !Number.isSafeInteger(input.count) ||
        input.count < 1 ||
        input.count > MAX_CODES_PER_BATCH
      ) {
        throw new PlatformError("invalid_request", `一次生成 1..${MAX_CODES_PER_BATCH} 个兑换码`);
      }
      if (!Number.isSafeInteger(input.maxRedemptions) || input.maxRedemptions < 1) {
        throw new PlatformError("invalid_request", "每个码的可核销次数必须是正整数");
      }
      let amountMicros: Micros;
      try {
        amountMicros = microsFromDecimalString(input.amount);
      } catch (error) {
        throw new PlatformError("invalid_request", "面额格式不正确（非负十进制金额）", {
          cause: error,
        });
      }
      if (amountMicros <= 0) {
        throw new PlatformError("invalid_request", "面额必须大于 0");
      }
      const now = deps.now();
      const created: RedeemCodeRecord[] = [];
      for (let index = 0; index < input.count; index += 1) {
        const record: RedeemCodeRecord = {
          id: deps.newRedeemCodeId(),
          code: generateRedeemCode(),
          amountMicros,
          maxRedemptions: input.maxRedemptions,
          redeemedCount: 0,
          expiresAt: input.expiresAt,
          createdBy: input.createdBy,
          revokedAt: null,
          createdAt: now,
        };
        await deps.redeems.insert(record);
        created.push(record);
      }
      this.record({
        actorUserId: input.createdBy,
        action: "redeem.create",
        targetType: "redeem_batch",
        targetId: null,
        detail: JSON.stringify({
          count: input.count,
          amount: formatMicros(amountMicros),
          maxRedemptions: input.maxRedemptions,
        }),
        now,
      });
      return created;
    },

    async listRedeemCodes() {
      return await deps.redeems.list();
    },

    async revokeRedeemCode({ codeId, actorUserId }) {
      const code = await deps.redeems.findById(codeId);
      if (!code) {
        throw new PlatformError("not_found", "兑换码不存在");
      }
      await deps.redeems.revoke(codeId, deps.now());
      this.record({
        actorUserId,
        action: "redeem.revoke",
        targetType: "redeem_code",
        targetId: codeId,
        detail: JSON.stringify({ code: code.code }),
        now: deps.now(),
      });
    },

    async redeemCode({ userId, code }) {
      const normalized = code.trim().toUpperCase();
      const record = await deps.redeems.findByCode(normalized);
      if (!record) {
        throw new PlatformError("invalid_request", "兑换码不存在");
      }
      const now = deps.now();
      const outcome = await deps.redeems.redeem({ codeId: record.id, userId, now });
      if (typeof outcome === "string") {
        const messages = {
          not_found: "兑换码不存在",
          revoked: "兑换码已被吊销",
          expired: "兑换码已过期",
          exhausted: "兑换码核销次数已用完",
          already_redeemed: "你已经核销过这个兑换码",
        } as const;
        throw new PlatformError("conflict", messages[outcome]);
      }
      // 核销事务成功后再入账：ledger 是余额的唯一事实源，失败时整个请求报错，
      // 用户重试会命中 already_redeemed，由管理员按 redemption 记录补账，不会超发。
      await deps.billing.applyLedger({
        userId,
        amountMicros: outcome.amountMicros,
        kind: "recharge",
        requestId: null,
        note: `兑换码核销 ${record.code}`,
        createdBy: null,
        now,
      });
      this.record({
        actorUserId: userId,
        action: "redeem.redeemed",
        targetType: "redeem_code",
        targetId: record.id,
        detail: JSON.stringify({ code: record.code, amount: formatMicros(outcome.amountMicros) }),
        now,
      });
      return { amountMicros: outcome.amountMicros };
    },

    async createApiKey({ userId, name, actorUserId }) {
      const user = await deps.users.findById(userId);
      if (!user) {
        throw new PlatformError("user_not_found", "用户不存在");
      }
      const plaintext = generateApiKeyPlaintext();
      const now = deps.now();
      const record: ApiKeyRecord = {
        id: deps.newApiKeyId(),
        userId,
        keyHash: await deps.hashApiKey(plaintext),
        keyHint: apiKeyHint(plaintext),
        name: name.trim().slice(0, 100),
        createdAt: now,
        lastUsedAt: null,
        revokedAt: null,
      };
      await deps.apiKeys.insert(record);
      this.record({
        actorUserId,
        action: "apikey.create",
        targetType: "api_key",
        targetId: record.id,
        detail: JSON.stringify({ userId, name: record.name }),
        now,
      });
      return { record, plaintext };
    },

    async listApiKeysForUser(userId) {
      return await deps.apiKeys.listByUser(userId);
    },

    async listAllApiKeys() {
      return await deps.apiKeys.listAll();
    },

    async revokeApiKey({ keyId, actorUserId }) {
      // 吊销是幂等的：重复吊销不报错，但不存在必须报错，否则管理员无从发现打错了 id。
      const all = await deps.apiKeys.listAll();
      const target = all.find((item) => item.id === keyId);
      if (!target) {
        throw new PlatformError("not_found", "API Key 不存在");
      }
      await deps.apiKeys.revoke(keyId, deps.now());
      this.record({
        actorUserId,
        action: "apikey.revoke",
        targetType: "api_key",
        targetId: keyId,
        detail: JSON.stringify({ userId: target.userId }),
        now: deps.now(),
      });
    },

    async authenticateApiKey(plaintext) {
      if (!plaintext.startsWith(API_KEY_PREFIX)) {
        return null;
      }
      const all = await deps.apiKeys.listAll();
      const now = deps.now();
      for (const record of all) {
        if (record.revokedAt !== null) {
          continue;
        }
        if (await deps.verifyApiKey(plaintext, record.keyHash)) {
          await deps.apiKeys.touchLastUsed(record.id, now);
          return record.userId;
        }
      }
      return null;
    },
  };
}
