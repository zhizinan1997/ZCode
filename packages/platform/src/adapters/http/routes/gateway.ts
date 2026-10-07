/**
 * 模型网关路由。
 *
 * 路径形如 `/api/v1/gateway/<providerId>/v1/messages`：客户端把平台管理的 provider 的
 * baseUrl 指向 `/api/v1/gateway/<providerId>`，SDK 在其后拼接自己的路径。
 *
 * 认证只用平台会话令牌：网关令牌与登录令牌是同一个，客户端不必持有第二份凭据。
 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { GatewayService } from "../../../app/gatewayService.js";
import { requireAuth } from "../helpers.js";

const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createGatewayRoutes(deps: {
  readonly accounts: AccountService;
  readonly gateway: GatewayService;
}): Hono {
  const routes = new Hono();

  routes.all("/:providerId/*", async (context) => {
    const session = await requireAuth(context, deps.accounts);
    const providerId = context.req.param("providerId");
    const method = context.req.method.toUpperCase();
    const bodyText = BODYLESS_METHODS.has(method)
      ? null
      : ((await context.req.text()) || null);

    return await deps.gateway.handle({
      userId: session.user.id,
      providerId,
      method,
      requestPath: context.req.path,
      search: new URL(context.req.url).search,
      headers: context.req.raw.headers,
      bodyText,
    });
  });

  return routes;
}
