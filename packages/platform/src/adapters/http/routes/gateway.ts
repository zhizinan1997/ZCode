/**
 * 模型网关路由。
 *
 * 路径形如 `/api/v1/gateway/<providerId>/v1/messages`：客户端把平台管理的 provider 的
 * baseUrl 指向 `/api/v1/gateway/<providerId>`，SDK 在其后拼接自己的路径。
 *
 * 认证支持两种凭据（specs/platform/operations.md）：
 * - 平台会话令牌（`zct1.` 开头）：客户端登录态，30 天过期；
 * - 用户 API Key（`zcpk_` 开头）：长期凭据，供 CLI/第三方工具使用。
 * 两者都解析为同一个 user.id，进入完全相同的计费链路；解析失败一律 401。
 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { GatewayService } from "../../../app/gatewayService.js";
import type { OperationsService } from "../../../app/operationsService.js";
import { PlatformError } from "../../../domain/errors.js";
import { readBearerToken } from "../../../domain/token.js";

const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const API_KEY_PREFIX = "zcpk_";

export function createGatewayRoutes(deps: {
  readonly accounts: AccountService;
  readonly operations: OperationsService;
  readonly gateway: GatewayService;
}): Hono {
  const routes = new Hono();

  const resolveUser = async (authorization: string | undefined) => {
    const token = readBearerToken(authorization);
    if (!token) {
      throw new PlatformError("unauthorized", "缺少访问令牌");
    }
    if (token.startsWith(API_KEY_PREFIX)) {
      const userId = await deps.operations.authenticateApiKey(token);
      if (!userId) {
        throw new PlatformError("unauthorized", "API Key 无效或已吊销");
      }
      const user = await deps.accounts.getUser(userId);
      if (user.status !== "active") {
        throw new PlatformError("user_disabled", "账号已停用");
      }
      return user;
    }
    const session = await deps.accounts.authenticate(token);
    return session.user;
  };

  routes.all("/:providerId/*", async (context) => {
    const user = await resolveUser(context.req.header("authorization"));
    const providerId = context.req.param("providerId");
    const method = context.req.method.toUpperCase();
    const bodyText = BODYLESS_METHODS.has(method) ? null : (await context.req.text()) || null;

    return await deps.gateway.handle({
      userId: user.id,
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
