import type { WebZaiOAuthProviderConfig } from "./zaiWebOAuthProvider.js";
import { buildZCodeEndpointUrls, resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";

interface WebImportMetaEnv {
  VITE_DEV_ORIGIN?: string;
  VITE_ZAI_OAUTH_CLIENT_ID?: string;
  VITE_ZAI_OAUTH_ORIGIN?: string;
  VITE_BIGMODEL_OAUTH_ORIGIN?: string;
  VITE_BIGMODEL_OAUTH_APP_ID?: string;
  VITE_ZCODE_BASE_URL?: string;
  VITE_ZCODE_ENDPOINT_ORIGIN?: string;
  VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO?: string;
}

export interface WebZaiOAuthConfig extends WebZaiOAuthProviderConfig {
  devOrigin?: string;
  shareRedirectUri: string;
  allowDevReturnToRedirect: boolean;
}

function normalizeZaiOAuthOrigin(value: string): string {
  return new URL(value.trim()).origin;
}

function buildZaiOAuthAuthorizeUrl(origin: string | undefined): string {
  // 商业版域名边界：不再回退厂商 chat.z.ai；未注入授权源时落到当前配置的服务地址。
  return `${normalizeZaiOAuthOrigin(origin?.trim() || resolveRuntimeZCodeEndpointOrigin())}/api/oauth/authorize`;
}

/**
 * BigModel 的授权入口。
 *
 * 必须跟随环境：测试环境写死 bigmodel.cn 会把测试账号带到生产授权页。构建期由
 * vite.config 注入 VITE_BIGMODEL_OAUTH_ORIGIN；缺失时退回当前配置的服务地址
 * （商业版域名边界：不回退厂商域名）。
 */
function buildBigModelAuthorizeUrl(origin: string | undefined): string {
  const trimmed = origin?.trim();
  const base = trimmed ? new URL(trimmed).origin : resolveRuntimeZCodeEndpointOrigin();
  return `${base}/login`;
}

function createWebZaiOAuthConfig(env: WebImportMetaEnv = {}): WebZaiOAuthConfig {
  const devOrigin = env.VITE_DEV_ORIGIN?.trim().replace(/\/$/, "");
  const zcodeEndpointUrls = buildZCodeEndpointUrls(
    env.VITE_ZCODE_BASE_URL?.trim() ||
      env.VITE_ZCODE_ENDPOINT_ORIGIN?.trim() ||
      resolveRuntimeZCodeEndpointOrigin(),
  );

  return {
    // ZAI 当前 OAuth 授权入口使用 /api/oauth 前缀，继续走 /auth/oauth 会打开旧入口。
    authorizeUrl: buildZaiOAuthAuthorizeUrl(env.VITE_ZAI_OAUTH_ORIGIN),
    tokenUrl: "/api/v1/oauth/token",
    // client_id 会出现在授权 URL 中，属于公开配置；这里允许 VITE_ 注入，
    // 但不再内置厂商 client id（商业版域名边界）。
    clientId: env.VITE_ZAI_OAUTH_CLIENT_ID?.trim() || "",
    bigmodelAuthorizeUrl: buildBigModelAuthorizeUrl(env.VITE_BIGMODEL_OAUTH_ORIGIN),
    // BigModel 用 appId 而不是 client_id，且默认值就是桌面端在用的 "zcode"。
    bigmodelAppId: env.VITE_BIGMODEL_OAUTH_APP_ID?.trim() || "zcode",
    redirectUri: zcodeEndpointUrls.webShareCallbackUrl,
    shareRedirectUri: zcodeEndpointUrls.webShareCallbackUrl,
    ...(devOrigin ? { devOrigin } : {}),
    allowDevReturnToRedirect: env.VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO === "true",
  };
}

const env = ((import.meta as ImportMeta & { env?: WebImportMetaEnv }).env ??
  {}) as WebImportMetaEnv;

export const WEB_ZAI_OAUTH_CONFIG: WebZaiOAuthConfig = createWebZaiOAuthConfig(env);

export function resolveWebAuthDevReturnTo(config: WebZaiOAuthConfig): string | undefined {
  return config.devOrigin ? `${config.devOrigin}/share/callback` : undefined;
}
