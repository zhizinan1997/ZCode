/**
 * HTTP 应用装配。
 *
 * 错误边界统一在 onError：已知的 PlatformError 原样映射为状态码 + 稳定错误码；
 * 未知异常只回通用文案，细节写服务端日志，避免把栈与内部结构泄露给客户端。
 */
import { Hono } from "hono";
import type { AccountService } from "../../app/accountService.js";
import type { BillingService } from "../../app/billingService.js";
import type { CatalogService } from "../../app/catalogService.js";
import type { GatewayService } from "../../app/gatewayService.js";
import type { PlanService } from "../../app/planService.js";
import type { ReleaseService } from "../../app/releaseService.js";
import type {
  GatewayProviderRepository,
  ModelPriceRepository,
  UsageRepository,
} from "../../app/ports.js";
import { PlatformError, toPlatformError } from "../../domain/errors.js";
import type { PlatformConfig } from "../config.js";
import type { Logger } from "../log.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createGatewayRoutes } from "./routes/gateway.js";
import { createPublicApiRoutes } from "./routes/publicApi.js";
import { createReleaseDownloadRoutes } from "./routes/adminReleases.js";
import { createConsoleRoutes } from "./consoleStatic.js";

export interface CreatePlatformAppOptions {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly accounts: AccountService;
  readonly billing: BillingService;
  readonly catalog: CatalogService;
  readonly plans: PlanService;
  readonly releases: ReleaseService;
  readonly gateway: GatewayService;
  readonly providers: GatewayProviderRepository;
  readonly prices: ModelPriceRepository;
  readonly usage: UsageRepository;
  readonly now: () => number;
  readonly newProviderId: () => string;
}

export function createPlatformApp(options: CreatePlatformAppOptions): Hono {
  const app = new Hono();

  app.onError((error, context) => {
    const platformError = toPlatformError(error);
    if (platformError.code === "internal_error") {
      options.logger.error("请求处理失败", {
        method: context.req.method,
        path: context.req.path,
        error: platformError.message,
        cause: platformError.cause instanceof Error ? platformError.cause.message : undefined,
        stack: platformError.cause instanceof Error ? platformError.cause.stack : undefined,
      });
    }
    return context.json(
      { error: { code: platformError.code, message: platformError.message } },
      platformError.status as 400,
    );
  });

  app.get("/api/health", (context) => context.json({ ok: true }));

  // 客户端消费的公开接口：模型目录、更新清单、自身账单。
  app.route(
    "/api/v1",
    createPublicApiRoutes({
      accounts: options.accounts,
      billing: options.billing,
      catalog: options.catalog,
      releases: options.releases,
      config: options.config,
      logger: options.logger,
    }),
  );

  // 模型网关：上游 key 与余额判定都在这里收口。
  app.route(
    "/api/v1/gateway",
    createGatewayRoutes({ accounts: options.accounts, gateway: options.gateway }),
  );

  app.route("/api/auth", createAuthRoutes(options.accounts));

  app.route(
    "/api/admin",
    createAdminRoutes({
      accounts: options.accounts,
      billing: options.billing,
      catalog: options.catalog,
      plans: options.plans,
      releases: options.releases,
      providers: options.providers,
      prices: options.prices,
      usage: options.usage,
      now: options.now,
      newProviderId: options.newProviderId,
      releasesDir: options.config.releasesDir,
    }),
  );

  app.route("/", createReleaseDownloadRoutes({ releasesDir: options.config.releasesDir }));
  app.route("/", createConsoleRoutes({ consoleDir: options.config.consoleDir }));

  app.notFound((context) =>
    context.json({ error: { code: "not_found", message: "接口不存在" } }, 404),
  );

  return app;
}

export { PlatformError };
