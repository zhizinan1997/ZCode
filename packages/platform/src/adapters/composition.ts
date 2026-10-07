/**
 * 组装根：把配置、数据库、仓储、领域能力接到一条链上。
 * entry（服务进程）与测试都只调用这里，避免两处各自拼装出不一致的运行时。
 */
import { createAccountService, type AccountService } from "../app/accountService.js";
import { createBillingService, type BillingService } from "../app/billingService.js";
import { createCatalogService, type CatalogService } from "../app/catalogService.js";
import { createGatewayService, type GatewayService } from "../app/gatewayService.js";
import { createPlanService, type PlanService } from "../app/planService.js";
import { createReleaseService, type ReleaseService } from "../app/releaseService.js";
import type { PlatformRepositories, UpstreamTransport } from "../app/ports.js";
import { newLedgerEntryId, newPlanId, newProviderId, newReleaseId, newRequestId, newSessionId, newSubscriptionId, newUserId } from "./crypto/ids.js";
import { createTokenSigner } from "./crypto/tokenSigner.js";
import { hashPassword, verifyPassword } from "./crypto/passwordHash.js";
import type { PlatformConfig } from "./config.js";
import { createLogger, type Logger } from "./log.js";
import { createFetchUpstreamTransport } from "./http/upstreamTransport.js";
import { createSqliteBillingRepository } from "./sqlite/billingRepo.js";
import { createSqliteUsageRepository } from "./sqlite/usageRepo.js";
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
  readonly gateway: GatewayService;
  readonly newProviderId: () => string;
  dispose(): void;
}

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
  };

  const signer = createTokenSigner(options.config.tokenSecret);
  const accounts = createAccountService({
    users: repositories.users,
    sessions: repositories.sessions,
    now,
    newUserId,
    newSessionId,
    hashPassword,
    verifyPassword,
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

  const catalog = createCatalogService({ catalog: repositories.catalog, now });
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
  const gateway = createGatewayService({
    providers: repositories.providers,
    prices: repositories.prices,
    billing,
    usage: repositories.usage,
    transport:
      options.upstreamTransport ??
      createFetchUpstreamTransport({ timeoutMs: options.config.upstreamTimeoutMs }),
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
    gateway,
    newProviderId,
    dispose() {
      database.close();
    },
  };
}

export { newLedgerEntryId };
