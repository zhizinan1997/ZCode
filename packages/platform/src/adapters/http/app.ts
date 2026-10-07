/**
 * HTTP 应用装配。
 *
 * 错误边界统一在 onError：已知的 PlatformError 原样映射为状态码 + 稳定错误码；
 * 未知异常只回通用文案，细节写服务端日志，避免把栈与内部结构泄露给客户端。
 */
import { Hono, type Context, type Next } from "hono";
import type { AccountService } from "../../app/accountService.js";
import type { BillingService } from "../../app/billingService.js";
import type { CatalogService } from "../../app/catalogService.js";
import type { GatewayService } from "../../app/gatewayService.js";
import type { OperationsService } from "../../app/operationsService.js";
import type { ModelPublishService } from "../../app/modelPublishService.js";
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
import { createPublicOperationRoutes } from "./routes/adminOperations.js";
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
  readonly operations: OperationsService;
  readonly modelPublish: ModelPublishService;
  readonly gateway: GatewayService;
  readonly providers: GatewayProviderRepository;
  readonly prices: ModelPriceRepository;
  readonly usage: UsageRepository;
  readonly now: () => number;
  readonly newProviderId: () => string;
  /** API 请求体上限（字节）；默认 32MB，测试可调小。见 B8 请求体上限。 */
  readonly maxBodyBytes?: number;
}

/** API 请求体上限默认值：32MB 足够模型对话的大上下文，又挡住"超大 body 打满内存"。 */
export const DEFAULT_MAX_API_BODY_BYTES = 32 * 1024 * 1024;

/** 安装包上传路径：可达数百 MB（deploy/Caddyfile 放到 2GB），不适用普通 API 的上限。 */
function isReleaseUploadPath(context: Context): boolean {
  return context.req.method === "PUT" && context.req.path.startsWith("/api/admin/releases/");
}

function payloadTooLarge(context: Context, maxBytes: number): Response {
  return context.json(
    {
      error: {
        code: "payload_too_large",
        message: `请求体超过上限（${maxBytes} 字节）`,
      },
    },
    413,
  );
}

/**
 * 请求体大小上限。
 *
 * 走 Content-Length 快路径；没有 Content-Length（chunked）时边读边计数，超过上限
 * 立即 413。不能用 hono/body-limit：它把超限错误抛进下游解析，会被 readJsonObject
 * 统一归为 400（invalid_request），达不到"超出即 413"的要求。
 * 只检查请求体，不缓冲响应，因此 SSE 流式输出不受影响。
 */
function createApiBodyLimitMiddleware(maxBytes: number) {
  return async (context: Context, next: Next): Promise<Response | void> => {
    if (isReleaseUploadPath(context)) {
      await next();
      return;
    }
    const request = context.req.raw;
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && !request.headers.has("transfer-encoding")) {
      const declared = Number(contentLength);
      if (Number.isFinite(declared) && declared > maxBytes) {
        return payloadTooLarge(context, maxBytes);
      }
      await next();
      return;
    }
    if (!request.body) {
      await next();
      return;
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return payloadTooLarge(context, maxBytes);
      }
      chunks.push(value);
    }
    // 重建请求交给下游，body 内容与请求头保持不变。
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    context.req.raw = new Request(request, { body: merged, duplex: "half" } as RequestInit);
    await next();
  };
}

export function createPlatformApp(options: CreatePlatformAppOptions): Hono {
  const app = new Hono();
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_API_BODY_BYTES;

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

  // 审计：API 请求体上限（发布产物上传除外，见 B8 说明）。
  app.use("/api/*", createApiBodyLimitMiddleware(maxBodyBytes));

  app.get("/api/health", (context) => context.json({ ok: true }));

  // 客户端消费的公开接口：模型目录、更新清单、自身账单。
  app.route(
    "/api/v1",
    createPublicApiRoutes({
      accounts: options.accounts,
      billing: options.billing,
      catalog: options.catalog,
      releases: options.releases,
      operations: options.operations,
      config: options.config,
      logger: options.logger,
    }),
  );

  // 用户自助运营接口：兑换码核销、自己的 API Key。
  app.route(
    "/api/v1",
    createPublicOperationRoutes({
      accounts: options.accounts,
      operations: options.operations,
    }),
  );

  // 模型网关：上游 key 与余额判定都在这里收口。
  app.route(
    "/api/v1/gateway",
    createGatewayRoutes({
      accounts: options.accounts,
      operations: options.operations,
      gateway: options.gateway,
    }),
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
      operations: options.operations,
      modelPublish: options.modelPublish,
      providers: options.providers,
      prices: options.prices,
      usage: options.usage,
      now: options.now,
      newProviderId: options.newProviderId,
      releasesDir: options.config.releasesDir,
      logger: options.logger,
    }),
  );

  app.route(
    "/",
    createReleaseDownloadRoutes({
      releasesDir: options.config.releasesDir,
      releases: options.releases,
    }),
  );
  app.route("/", createConsoleRoutes({ consoleDir: options.config.consoleDir }));

  app.notFound((context) =>
    context.json({ error: { code: "not_found", message: "接口不存在" } }, 404),
  );

  return app;
}

export { PlatformError };
