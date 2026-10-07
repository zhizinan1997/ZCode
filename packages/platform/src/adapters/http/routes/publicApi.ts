/**
 * 面向客户端的公开接口。
 *
 * 这些路径是**客户端已经实现的契约**，不能随意改动：
 *   GET /api/v1/client/configs              → data.configs.builtin_provider_config_json
 *   GET /api/v1/catalog/<revision>.json     → 模型目录全文
 *   GET /api/v1/releases/electron/manifest  → 更新清单（YAML）
 * 另外提供 /api/v1/billing/me 供客户端展示余额与套餐。
 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { BillingService } from "../../../app/billingService.js";
import type { CatalogService } from "../../../app/catalogService.js";
import type { OperationsService } from "../../../app/operationsService.js";
import type { ReleaseService } from "../../../app/releaseService.js";
import { PlatformError } from "../../../domain/errors.js";
import { resolveReleaseChannelFromQuery } from "../../../domain/releases.js";
import type { PlatformConfig } from "../../config.js";
import type { Logger } from "../../log.js";
import { requireAuth } from "../helpers.js";

/**
 * 站点根地址。
 *
 * 优先用配置值；没有配置时从请求头推断，并在日志里提示一次——
 * x-forwarded-* 是客户端可伪造的，反向代理后面必须显式配置
 * ZCODE_PLATFORM_PUBLIC_ORIGIN，否则客户端拿到的地址可能被指向别处。
 */
function resolveRequestOrigin(options: {
  requestUrl: string;
  headers: Headers;
  configured: string | null;
  logger: Logger;
  warned: { value: boolean };
}): string {
  if (options.configured) {
    return options.configured;
  }
  if (!options.warned.value) {
    options.warned.value = true;
    options.logger.warn(
      "未配置 ZCODE_PLATFORM_PUBLIC_ORIGIN，正在从请求头推断站点地址；请在生产环境显式配置",
    );
  }
  const url = new URL(options.requestUrl);
  const forwardedProto = options.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = options.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const protocol = forwardedProto || url.protocol.replace(":", "");
  const host = forwardedHost || options.headers.get("host") || url.host;
  return `${protocol}://${host}`;
}

export function createPublicApiRoutes(deps: {
  readonly accounts: AccountService;
  readonly billing: BillingService;
  readonly catalog: CatalogService;
  readonly releases: ReleaseService;
  readonly operations: OperationsService;
  readonly config: PlatformConfig;
  readonly logger: Logger;
}): Hono {
  const routes = new Hono();
  const originWarning = { value: false };

  const resolveOrigin = (context: Parameters<typeof requireAuth>[0]) =>
    resolveRequestOrigin({
      requestUrl: context.req.url,
      headers: context.req.raw.headers,
      configured: deps.config.publicOrigin,
      logger: deps.logger,
      warned: originWarning,
    });

  routes.get("/client/configs", async (context) => {
    const payload = await deps.catalog.buildClientConfigsWithOperations(
      resolveOrigin(context),
      deps.operations,
    );
    return context.json(payload);
  });

  // 用普通参数而不是正则参数（`:revision{[0-9]+}.json` 会让 Hono 的路由器在构建期抛错，
  // 而且一个坏路由会让整个 app 都无法匹配任何请求）。这里接受 "1" 或 "1.json" 两种写法。
  routes.get("/catalog/:revision", async (context) => {
    const raw = context.req.param("revision").trim();
    const normalized = raw.endsWith(".json") ? raw.slice(0, -".json".length) : raw;
    if (!/^[0-9]+$/.test(normalized)) {
      throw new PlatformError("not_found", "目录地址非法");
    }
    const revision = Number(normalized);
    const found = await deps.catalog.readByRevision(revision);
    if (!found) {
      throw new PlatformError("not_found", `目录 revision ${revision} 不存在`);
    }
    return context.body(found.content, 200, {
      "content-type": "application/json; charset=utf-8",
      // 按 revision 固定 URL，内容不可变，可以长缓存。
      "cache-control": "public, max-age=86400, immutable",
    });
  });

  routes.get("/releases/electron/manifest", async (context) => {
    const platform = context.req.query("platform")?.trim();
    if (!platform) {
      throw new PlatformError("invalid_request", "缺少 platform 参数");
    }
    const channel = resolveReleaseChannelFromQuery(context.req.query("channel"));
    const manifest = await deps.releases.buildManifest({ platform, channel });
    if (!manifest) {
      // 该平台该通道还没有发布：返回 404 让客户端保持当前版本。
      // 走统一错误处理，保持与其他接口一致的 JSON 错误结构。
      throw new PlatformError("not_found", `该平台（${platform}）的 ${channel} 通道还没有发布版本`);
    }
    return context.body(manifest, 200, {
      "content-type": "application/x-yaml; charset=utf-8",
      "cache-control": "no-cache",
    });
  });

  routes.get("/billing/me", async (context) => {
    const session = await requireAuth(context, deps.accounts);
    const [summary, totals] = await Promise.all([
      deps.billing.getSummary(session.user.id),
      deps.billing.getUsageTotals({ userId: session.user.id }),
    ]);
    return context.json({
      balanceMicros: summary.balanceMicros,
      reservedMicros: summary.reservedMicros,
      availableMicros: summary.availableMicros,
      plan: summary.plan
        ? {
            id: summary.plan.id,
            name: summary.plan.name,
            allowedModels: summary.plan.allowedModels,
          }
        : null,
      subscription: summary.subscription
        ? {
            id: summary.subscription.id,
            remainingMicros: summary.subscription.remainingMicros,
            startsAt: summary.subscription.startsAt,
            expiresAt: summary.subscription.expiresAt,
          }
        : null,
      usageTotals: totals,
    });
  });

  return routes;
}
