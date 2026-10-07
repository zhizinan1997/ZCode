/**
 * app 层依赖的端口。app 只依赖这些接口，不感知 SQLite、HTTP 等具体实现，
 * 因此用例可以在内存实现上直接测试。
 */
import type { SessionRecord } from "../domain/session.ts";
import type { PlatformRole, UserRecord, UserStatus } from "../domain/user.js";
import type { LedgerEntry, LedgerKind, UsageRecord, UsageStatus } from "../domain/billing.js";
import type { GatewayProvider } from "../domain/gateway.js";
import type { Micros, ModelPrice, TokenUsage } from "../domain/money.js";
import type { PlanRecord, SubscriptionRecord } from "../domain/plans.js";
import type { ReleaseChannel, ReleaseRecord } from "../domain/releases.js";
import type {
  ApiKeyRecord,
  AuditAppend,
  AuditLogEntry,
  RedeemCodeRecord,
  RedeemRedemptionRecord,
  RedeemRejection,
  SettingKey,
} from "../domain/operations.js";

export interface UserRepository {
  insert(user: UserRecord): Promise<void>;
  update(user: UserRecord): Promise<void>;
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  /** 是否存在指定角色的用户；用于引导管理员的判定，避免分页漏判。 */
  existsWithRole(role: PlatformRole): Promise<boolean>;
  /** 指定角色且状态为 active 的用户数；用于"最后一个启用管理员"保护（审计#11）。 */
  countActiveWithRole(role: PlatformRole): Promise<number>;
  list(options: { limit: number; offset: number }): Promise<UserRecord[]>;
  count(): Promise<number>;
  /** 按邮箱或显示名模糊过滤的分页列表；q 为空时等价于 list。 */
  search(options: { q: string; limit: number; offset: number }): Promise<UserRecord[]>;
  /** 与 search 同条件的总数；分页需要 total。 */
  countSearch(options: { q: string }): Promise<number>;
  remove(userId: string): Promise<void>;
}

export interface SessionRepository {
  insert(session: SessionRecord): Promise<void>;
  findById(id: string): Promise<SessionRecord | null>;
  revoke(id: string, revokedAt: number): Promise<void>;
  /** 撤销某用户全部未撤销会话；停用与管理员重置密码时使用。 */
  revokeAllForUser(userId: string, revokedAt: number): Promise<void>;
  /** 撤销除指定会话外的全部会话；用户自己改密时保留当前会话。 */
  revokeAllForUserExcept(userId: string, exceptSessionId: string, revokedAt: number): Promise<void>;
  /** 清理已过期的会话记录，避免表无限增长。 */
  deleteExpiredBefore(timestamp: number): Promise<number>;
}

export interface AccountServiceDependencies {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  /** 当前时间（epoch 毫秒）。注入以便测试控制时间流逝。 */
  readonly now: () => number;
  readonly newUserId: () => string;
  readonly newSessionId: () => string;
  readonly hashPassword: (plain: string) => Promise<string>;
  readonly verifyPassword: (plain: string, stored: string) => Promise<boolean>;
  /** 记录是否为需要升级为 scrypt 的历史 bcrypt 哈希；登录成功后据此重写。 */
  readonly needsPasswordRehash: (stored: string) => boolean;
  readonly signToken: (claims: {
    sub: string;
    role: PlatformRole;
    sid: string;
    iat: number;
    exp: number;
  }) => string;
  /** 会话有效期（毫秒）。 */
  readonly sessionTtlMs: number;
}

export interface UserListPage {
  readonly users: UserRecord[];
  readonly total: number;
}

export interface CreateUserInput {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
  readonly role?: PlatformRole;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly userAgent?: string;
}

export interface LoginResult {
  readonly token: string;
  readonly expiresAt: number;
  readonly user: UserRecord;
}

export interface AuthenticatedContext {
  readonly user: UserRecord;
  readonly session: SessionRecord;
}

export interface SetUserStatusInput {
  readonly userId: string;
  readonly status: UserStatus;
}

/** 管理员更新用户；字段全部可选，至少提供一项（由 accountService 校验）。 */
export interface UpdateUserInput {
  readonly userId: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly role?: PlatformRole;
  readonly status?: UserStatus;
}

export interface GatewayProviderRepository {
  list(): Promise<GatewayProvider[]>;
  findById(id: string): Promise<GatewayProvider | null>;
  upsert(provider: GatewayProvider): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface ModelPriceRecord extends ModelPrice {
  readonly modelId: string;
  readonly updatedAt: number;
}

export interface ModelPriceRepository {
  list(): Promise<ModelPriceRecord[]>;
  findByModelId(modelId: string): Promise<ModelPriceRecord | null>;
  upsert(record: ModelPriceRecord): Promise<void>;
  remove(modelId: string): Promise<void>;
}

export interface LedgerMutation {
  readonly userId: string;
  /** 正数为加钱，负数为扣钱。 */
  readonly amountMicros: number;
  readonly kind: LedgerKind;
  readonly requestId?: string | null;
  readonly note?: string | null;
  readonly createdBy?: string | null;
  readonly now: number;
}

/**
 * 余额与流水。
 *
 * `applyLedger` 必须在同一事务里写流水与余额：余额是派生值，流水是事实源，
 * 两者分写会留下无法对账的中间态。
 */
export interface BillingRepository {
  getBalance(userId: string): Promise<Micros>;
  /** 余额是否已初始化（新用户首次充值前可能没有行）。 */
  applyLedger(mutation: LedgerMutation): Promise<void>;
  listLedger(options: { userId?: string; limit: number; offset: number }): Promise<LedgerEntry[]>;
  countLedger(userId?: string): Promise<number>;
  /** 用流水重算余额，用于对账。 */
  recomputeBalance(userId: string): Promise<Micros>;
  /** 按类型与起始时间汇总流水金额；概览页"今日充值"用它，只读不改账。 */
  sumLedgerSince(options: { kinds: LedgerKind[]; since: number }): Promise<Micros>;
  /** 全部用户余额合计；概览页的平台负债 = SUM(balances.balance_micros)。 */
  sumBalances(): Promise<Micros>;
}

export interface UsageAppend {
  readonly requestId: string;
  readonly userId: string;
  readonly providerId: string;
  readonly modelId: string | null;
  readonly costMicros: Micros;
  readonly httpStatus: number | null;
  readonly durationMs: number | null;
  readonly now: number;
}

export interface UsageSettlement {
  readonly requestId: string;
  readonly userId: string;
  readonly usage: TokenUsage;
  /** 实际费用；调用方按用量算好（含"用量缺失"兜底），事务内不再改价。 */
  readonly costMicros: Micros;
  readonly status: UsageStatus;
  readonly httpStatus: number | null;
  readonly errorMessage: string | null;
  readonly now: number;
}

export interface UsageRecordQuery {
  readonly userId?: string;
  readonly limit: number;
  readonly offset: number;
  /** 只返回该时间点之后的记录（epoch 毫秒）。 */
  readonly since?: number;
}

export interface UsageTotals {
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costMicros: Micros;
  readonly errorCount: number;
}

export interface UsageAggregateRow {
  readonly userId: string;
  readonly totals: UsageTotals;
}

/** 按模型聚合的一行用量；model_id 为 NULL 的记录不参与聚合。 */
export interface AggregateModelRow {
  readonly modelId: string;
  readonly totals: UsageTotals;
}

/** 原子预扣的结果；除 reserved 外都不应继续转发上游。 */
export type ReservationOutcome = "reserved" | "insufficient_balance" | "duplicate";

/** 原子结算的结果；settled=false 表示该请求已经结算过（幂等命中，本次未记账）。 */
export interface UsageSettlementOutcome {
  readonly settled: boolean;
  readonly fromPlanMicros: Micros;
  readonly fromBalanceMicros: Micros;
  readonly shortfallMicros: Micros;
}

export interface UsageRepository {
  /**
   * 建立预扣记录；`costMicros` 是预扣金额。
   * 返回 false 表示该 request_id 已经存在（重试或重复提交），调用方必须据此拒绝，不得转发上游。
   */
  insertReservation(record: UsageAppend): Promise<boolean>;
  /**
   * 原子预扣（审计#7）：在同一 BEGIN IMMEDIATE 事务里计算可用额度
   * （余额 − 未结算预扣 + 有效订阅剩余）并插入 reserved 记录。
   * 分开查询与写入会被并发请求穿插，两个请求都通过准入检查后一起超支。
   */
  reserveForRequest(record: UsageAppend): Promise<ReservationOutcome>;
  /**
   * 结算：写入实际用量与费用，并把状态从 reserved 改为终态。
   * 返回是否真的完成了状态迁移；false 表示该请求已结算过（重试），调用方不得再记账。
   */
  settle(settlement: UsageSettlement): Promise<boolean>;
  /**
   * 原子结算（审计#6/#8）：单个事务完成「状态改终态 + 套餐扣减 + 余额封顶扣减 + 写流水」。
   * 余额封顶用**真实余额**（预扣不是实际扣款），差额记 shortfall。
   * 任一步失败整体回滚，用量记录仍停在 reserved，由滞留预扣释放兜底；
   * settled=false 表示记录不是 reserved（已结算过），绝不重复记账。
   */
  settleWithBilling(settlement: UsageSettlement): Promise<UsageSettlementOutcome>;
  findById(requestId: string): Promise<UsageRecord | null>;
  /** 未结算的预扣总额，用于计算可用余额。 */
  sumReservedMicros(userId: string): Promise<Micros>;
  list(query: UsageRecordQuery): Promise<UsageRecord[]>;
  count(query: Omit<UsageRecordQuery, "limit" | "offset">): Promise<number>;
  totals(query: Omit<UsageRecordQuery, "limit" | "offset">): Promise<UsageTotals>;
  /** 按用户聚合，供管理后台看用量排行。 */
  aggregateByUser(options: { since?: number; limit: number }): Promise<UsageAggregateRow[]>;
  /** 按模型聚合，供管理后台看模型用量排行；只统计有模型 id 的已结算记录。 */
  aggregateByModel(options: { since?: number; limit: number }): Promise<AggregateModelRow[]>;
  /** 释放长期停留在 reserved 的预扣（进程在转发与结算之间崩溃时留下的）。 */
  releaseStaleReservations(options: { olderThan: number; now: number }): Promise<number>;
}

export interface CatalogRepository {
  /** 当前 revision 与内容；空库返回 null。 */
  readCurrent(): Promise<{ revision: number; content: string } | null>;
  readByRevision(revision: number): Promise<{ revision: number; content: string } | null>;
  /**
   * 写入新 revision，返回写入后的 revision。
   *
   * `revision` 用**目录内容里声明的那个值**，而不是另起一个自增计数：
   * 客户端按内容里的 revision 判断是否应用，而下载地址又由 revision 拼成，
   * 两者必须是同一个数，否则客户端拿到的文件与 URL 会对不上。
   */
  write(input: {
    content: string;
    revision: number;
    expectedRevision: number | null;
    updatedBy: string | null;
    now: number;
  }): Promise<number>;
}

export interface PlanRepository {
  listPlans(): Promise<PlanRecord[]>;
  findPlan(planId: string): Promise<PlanRecord | null>;
  upsertPlan(plan: PlanRecord): Promise<void>;
  removePlan(planId: string): Promise<void>;
  listSubscriptions(userId: string): Promise<SubscriptionRecord[]>;
  /** 该套餐被多少订阅引用；删除套餐前用它给出可读提示。 */
  countSubscriptionsByPlan(planId: string): Promise<number>;
  findSubscription(subscriptionId: string): Promise<SubscriptionRecord | null>;
  upsertSubscription(subscription: SubscriptionRecord): Promise<void>;
  revokeSubscriptions(userId: string, now: number): Promise<void>;
  /** 扣减套餐剩余额度；额度不足时返回实际扣减额。 */
  consumeSubscriptionQuota(options: {
    subscriptionId: string;
    amountMicros: Micros;
  }): Promise<Micros>;
}

export interface ReleaseRepository {
  upsert(record: ReleaseRecord): Promise<void>;
  list(): Promise<ReleaseRecord[]>;
  listByTag(options: { channel: ReleaseChannel; platform: string }): Promise<ReleaseRecord[]>;
  findById(id: string): Promise<ReleaseRecord | null>;
  remove(id: string): Promise<void>;
}

export interface PlatformRepositories {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly providers: GatewayProviderRepository;
  readonly prices: ModelPriceRepository;
  readonly billing: BillingRepository;
  readonly usage: UsageRepository;
  readonly catalog: CatalogRepository;
  readonly plans: PlanRepository;
  readonly releases: ReleaseRepository;
  readonly audit: AuditRepository;
  readonly settings: SettingsRepository;
  readonly redeems: RedeemRepository;
  readonly apiKeys: ApiKeyRepository;
  readonly publish: ModelPublishRepository;
}

import type { ModelPublishRepository } from "./publishPort.js";
export type { ModelPublishRepository };

export interface UpstreamForwardRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

/**
 * 转发到真实上游。
 *
 * 抽成端口是为了让网关的预扣/结算逻辑可以在不联外网的情况下测试——
 * 计费正确性不该依赖真实厂商可用。
 */
export interface UpstreamTransport {
  forward(request: UpstreamForwardRequest): Promise<Response>;
}

/** 审计日志：只追加。写失败不能让业务操作失败（service 层兜底）。 */
export interface AuditRepository {
  append(entry: AuditAppend): Promise<void>;
  list(options: {
    action?: string;
    /** 按操作者精确过滤；管理后台审计页按人筛选时使用。 */
    actor?: string;
    limit: number;
    offset: number;
  }): Promise<{ entries: AuditLogEntry[]; total: number }>;
}

/** 系统设置：单行键值。DB 值优先于 env 默认。 */
export interface SettingsRepository {
  read(key: SettingKey): Promise<string | null>;
  readAll(): Promise<Map<string, string>>;
  write(key: SettingKey, value: string, updatedBy: string | null, now: number): Promise<void>;
}

/**
 * 兑换码。`redeem` 是防超发的完整事务：重数、过期、吊销、单人一次都在锁内判定。
 * 失败返回稳定原因，成功返回核销记录（金额随后由 service 写 ledger）。
 */
export interface RedeemRepository {
  findByCode(code: string): Promise<RedeemCodeRecord | null>;
  findById(id: string): Promise<RedeemCodeRecord | null>;
  list(): Promise<RedeemCodeRecord[]>;
  insert(record: RedeemCodeRecord): Promise<void>;
  revoke(id: string, now: number): Promise<void>;
  redeem(options: {
    codeId: string;
    userId: string;
    now: number;
  }): Promise<RedeemRedemptionRecord | RedeemRejection>;
  listRedemptionsByUser(userId: string): Promise<RedeemRedemptionRecord[]>;
  countRedemptionsByCode(codeId: string): Promise<number>;
}

/** 用户 API Key。keyHash 是 scrypt 派生值；明文只在创建响应出现一次。 */
export interface ApiKeyRepository {
  insert(record: ApiKeyRecord): Promise<void>;
  findByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  listByUser(userId: string): Promise<ApiKeyRecord[]>;
  listAll(): Promise<ApiKeyRecord[]>;
  revoke(id: string, now: number): Promise<void>;
  touchLastUsed(id: string, now: number): Promise<void>;
  revokeAllForUser(userId: string, now: number): Promise<void>;
}
