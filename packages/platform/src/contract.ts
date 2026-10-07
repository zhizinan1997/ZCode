/**
 * platform 模块公开契约。
 *
 * 其他模块只允许从这里 import。当前唯一消费者是平台服务进程自身（另一入口是 HTTP，
 * 客户端通过接口而非代码依赖本模块），因此契约保持最小：配置、运行时、HTTP 应用。
 */
export type { PlatformConfig } from "./adapters/config.js";
export { resolvePlatformConfig } from "./adapters/config.js";

export type { CreatePlatformRuntimeOptions, PlatformRuntime } from "./adapters/composition.js";
export { createPlatformRuntime } from "./adapters/composition.js";

export type { CreatePlatformAppOptions } from "./adapters/http/app.js";
export { createPlatformApp } from "./adapters/http/app.js";

export type { AccountService } from "./app/accountService.js";
export { createAccountService, requireAdmin } from "./app/accountService.js";
export type { AccountSummary, BillingService } from "./app/billingService.js";
export { createBillingService } from "./app/billingService.js";
export type { CatalogContentSummary, CatalogService } from "./app/catalogService.js";
export { createCatalogService } from "./app/catalogService.js";
export type { GatewayRequestInput, GatewayService } from "./app/gatewayService.js";
export { createGatewayService } from "./app/gatewayService.js";
export type { PlanService } from "./app/planService.js";
export { createPlanService } from "./app/planService.js";
export type { ReleaseService } from "./app/releaseService.js";
export { createReleaseService } from "./app/releaseService.js";

export type {
  AccountServiceDependencies,
  AuthenticatedContext,
  BillingRepository,
  CatalogRepository,
  CreateUserInput,
  GatewayProviderRepository,
  LedgerMutation,
  LoginInput,
  LoginResult,
  ModelPriceRecord,
  ModelPriceRepository,
  PlanRepository,
  PlatformRepositories,
  ReleaseRepository,
  SessionRepository,
  UpstreamForwardRequest,
  UpstreamTransport,
  UsageAggregateRow,
  UsageAppend,
  UsageRecordQuery,
  UsageRepository,
  UsageSettlement,
  UsageTotals,
  UserListPage,
  UserRepository,
} from "./app/ports.js";

export type { LogLevel, Logger } from "./adapters/log.js";
export { createLogger } from "./adapters/log.js";

export type { PlatformErrorCode } from "./domain/errors.js";
export { PlatformError, isPlatformError, toPlatformError } from "./domain/errors.js";
export type { PublicUser, PlatformRole, UserRecord, UserStatus } from "./domain/user.js";
export { normalizeEmail, toPublicUser, validateEmail } from "./domain/user.js";
export type { TokenClaims } from "./domain/token.js";
export { readBearerToken } from "./domain/token.js";
export type { TokenSigner } from "./adapters/crypto/tokenSigner.js";
export { createTokenSigner } from "./adapters/crypto/tokenSigner.js";
export { hashPassword, verifyPassword } from "./adapters/crypto/passwordHash.js";
export {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePasswordStrength,
} from "./domain/passwordPolicy.js";

export type { LedgerEntry, LedgerKind, UsageRecord, UsageStatus } from "./domain/billing.js";
export {
  DEFAULT_RESERVE_OUTPUT_TOKENS,
  MIN_RESERVE_MICROS,
  estimateReserveMicros,
  resolveAvailableMicros,
  resolveSettledCostMicros,
} from "./domain/billing.js";
export type { GatewayProtocol, GatewayProvider } from "./domain/gateway.js";
export {
  GATEWAY_PATH_PREFIX,
  GATEWAY_PROTOCOLS,
  buildUpstreamUrl,
  resolveUpstreamPath,
} from "./domain/gateway.js";
export type { Micros, ModelPrice, TokenUsage } from "./domain/money.js";
export {
  MICROS_PER_UNIT,
  ZERO_PRICE,
  addMicros,
  canAfford,
  computeTokenCostMicros,
  formatMicros,
  microsFromDecimalString,
} from "./domain/money.js";
export type { PlanRecord, SubscriptionRecord } from "./domain/plans.js";
export {
  isModelAllowedByPlan,
  isSubscriptionActive,
  pickActiveSubscription,
} from "./domain/plans.js";
export type { ReleaseChannel, ReleaseRecord } from "./domain/releases.js";
export {
  RELEASE_CHANNELS,
  compareVersions,
  pickLatestRelease,
  resolveReleaseChannelFromQuery,
} from "./domain/releases.js";
export type { SseUsageAccumulator } from "./domain/usageParsing.js";
export { EMPTY_USAGE, createSseUsageAccumulator, readUsageFromJson } from "./domain/usageParsing.js";
