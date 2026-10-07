/**
 * 组装根：把配置、数据库、仓储、领域能力接到一条链上。
 * entry（服务进程）与测试都只调用这里，避免两处各自拼装出不一致的运行时。
 */
import { createAccountService, type AccountService } from "../app/accountService.js";
import { createBillingService, type BillingService } from "../app/billingService.js";
import { readBuiltinCatalogFile } from "../app/builtinCatalog.js";
import { createCatalogService, type CatalogService } from "../app/catalogService.js";
import { createGatewayService, type GatewayService } from "../app/gatewayService.js";
import { createModelPublishService, type ModelPublishService } from "../app/modelPublishService.js";
import { createOperationsService, type OperationsService } from "../app/operationsService.js";
import { createPlanService, type PlanService } from "../app/planService.js";
import { createReleaseService, type ReleaseService } from "../app/releaseService.js";
import type { PlatformRepositories, UpstreamTransport } from "../app/ports.js";
import {
  newLedgerEntryId,
  newApiKeyId,
  newPlanId,
  newProviderId,
  newRedeemCodeId,
  newReleaseId,
  newRequestId,
  newSessionId,
  newSubscriptionId,
  newUserId,
} from "./crypto/ids.js";
import { createTokenSigner } from "./crypto/tokenSigner.js";
import { hashPassword, needsPasswordRehash, verifyPassword } from "./crypto/passwordHash.js";
import type { PlatformConfig } from "./config.js";
import { createLogger, type Logger } from "./log.js";
import { createFetchUpstreamTransport } from "./http/upstreamTransport.js";
import { createSqliteBillingRepository } from "./sqlite/billingRepo.js";
import { createSqliteUsageRepository } from "./sqlite/usageRepo.js";
import {
  createSqliteAuditRepository,
  createSqliteApiKeyRepository,
  createSqliteRedeemRepository,
  createSqliteSettingsRepository,
} from "./sqlite/operationsRepo.js";
import {
  createSqliteCatalogRepository,
  createSqlitePlanRepository,
  createSqliteReleaseRepository,
} from "./sqlite/contentRepo.js";
import { openPlatformDatabase, type PlatformDatabase } from "./sqlite/database.js";
import {
  createSqliteGatewayProviderRepository,
  createSqliteModelPriceRepository,
} from "./sqlite/gatewayRepo.js";
import { createSqliteModelPublishRepository } from "./sqlite/publishRepo.js";
import { createSqliteSessionRepository } from "./sqlite/sessionRepo.js";
import { createSqliteUserRepository } from "./sqlite/userRepo.js";

export interface PlatformRuntime {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly database: PlatformDatabase;
  readonly repositories: PlatformRepositories;
  readonly accounts: AccountService;
  readonly billing: BillingService;
  readonly catalog: CatalogService;
  readonly plans: PlanService;
  readonly releases: ReleaseService;
  readonly operations: OperationsService;
  readonly modelPublish: ModelPublishService;
  readonly gateway: GatewayService;
  readonly newProviderId: () => string;
  dispose(): void;
}

/** 过期会话清理周期：启动清一次后每小时一次，避免 sessions 表无限增长。 */
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface CreatePlatformRuntimeOptions {
  readonly config: PlatformConfig;
  readonly logger?: Logger;
  /** 注入点：测试用它替换上游传输，从而在没有外网的情况下验证计费链路。 */
  readonly upstreamTransport?: UpstreamTransport;
  readonly now?: () => number;
}

export async function createPlatformRuntime(
  options: CreatePlatformRuntimeOptions,
): Promise<PlatformRuntime> {
  const logger =
    options.logger ?? createLogger({ scope: "platform", level: options.config.logLevel });
  const now = options.now ?? (() => Date.now());

  const database = await openPlatformDatabase({ path: options.config.dbPath, now });
  if (database.appliedMigrations.length > 0) {
    logger.info("平台数据库迁移完成", { migrations: database.appliedMigrations });
  }

  const repositories: PlatformRepositories = {
    users: createSqliteUserRepository(database.db),
    sessions: createSqliteSessionRepository(database.db),
    providers: createSqliteGatewayProviderRepository(database.db),
    prices: createSqliteModelPriceRepository(database.db),
    billing: createSqliteBillingRepository(database.db),
    usage: createSqliteUsageRepository(database.db),
    catalog: createSqliteCatalogRepository(database.db),
    plans: createSqlitePlanRepository(database.db),
    releases: createSqliteReleaseRepository(database.db),
    audit: createSqliteAuditRepository(database.db),
    settings: createSqliteSettingsRepository(database.db),
    redeems: createSqliteRedeemRepository(database.db),
    apiKeys: createSqliteApiKeyRepository(database.db),
    publish: createSqliteModelPublishRepository(database.db),
  };

  // 审计：已过期会话从未清理，sessions 表会无限增长。装配时清一次，
  // 之后每小时清一次；unref() 让定时器不阻止进程退出，失败只告警不影响服务。
  const cleanupExpiredSessions = async (): Promise<void> => {
    try {
      const removed = await repositories.sessions.deleteExpiredBefore(now());
      if (removed > 0) {
        logger.info("清理过期会话完成", { removed });
      }
    } catch (error) {
      logger.warn("清理过期会话失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await cleanupExpiredSessions();
  const sessionCleanupTimer = setInterval(() => {
    void cleanupExpiredSessions();
  }, SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer.unref();

  const signer = createTokenSigner(options.config.tokenSecret);
  const accounts = createAccountService({
    users: repositories.users,
    sessions: repositories.sessions,
    now,
    newUserId,
    newSessionId,
    hashPassword,
    verifyPassword,
    needsPasswordRehash,
    signToken: (claims) => signer.sign(claims),
    verifyToken: (token) => signer.verify(token),
    sessionTtlMs: options.config.sessionTtlMs,
  });

  const billing = createBillingService({
    billing: repositories.billing,
    usage: repositories.usage,
    plans: repositories.plans,
    now,
  });

  // 审计#20/#23：内置目录 revision 是目录保存的下限之一（客户端在内置与远程之间取较大者），
  // 发布页的能力预填也来自它；文件缺失时服务仍可启动，下限退化为库内当前值。
  const builtinCatalog = await readBuiltinCatalogFile();
  const catalog = createCatalogService({
    catalog: repositories.catalog,
    now,
    builtin: builtinCatalog,
  });
  const plans = createPlanService({
    plans: repositories.plans,
    now,
    newPlanId,
    newSubscriptionId,
  });
  const releases = createReleaseService({
    releases: repositories.releases,
    now,
    newReleaseId,
  });
  const operations = createOperationsService({
    audit: repositories.audit,
    settings: repositories.settings,
    redeems: repositories.redeems,
    apiKeys: repositories.apiKeys,
    billing: repositories.billing,
    users: repositories.users,
    now,
    logger,
    hashApiKey: hashPassword,
    verifyApiKey: verifyPassword,
    newRedeemCodeId,
    newApiKeyId,
  });
  const modelPublish = createModelPublishService({
    publish: repositories.publish,
    providers: repositories.providers,
    catalog,
    // 站点地址是生成目录 baseUrl 的事实源；null 时 preview/apply 给出可读错误，
    // 而不是推出一份客户端拒绝的目录。
    getPublicOrigin: () => options.config.publicOrigin,
    now,
  });
  const gateway = createGatewayService({
    providers: repositories.providers,
    prices: repositories.prices,
    publish: repositories.publish,
    billing,
    usage: repositories.usage,
    transport:
      options.upstreamTransport ??
      // 审计#14：上游超时是无数据超时（每次收到分片即重置），不再有总时长上限。
      createFetchUpstreamTransport({ idleTimeoutMs: options.config.upstreamIdleTimeoutMs }),
    now,
    newRequestId,
    outputTokenCap: options.config.outputTokenCap,
  });

  return {
    config: options.config,
    logger,
    database,
    repositories,
    accounts,
    billing,
    catalog,
    plans,
    releases,
    operations,
    modelPublish,
    gateway,
    newProviderId,
    dispose() {
      clearInterval(sessionCleanupTimer);
      database.close();
    },
  };
}

export { newLedgerEntryId };
