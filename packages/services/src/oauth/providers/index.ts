import type { ApiClient } from "@zcode/shared";
import type { OAuthRuntimeConfig } from "../runtimeConfig.js";
import type { OAuthProviderAdapter } from "./providerAdapter.js";

/**
 * 创建 OAuth provider adapter。
 *
 * 商业版域名边界：Z.ai / BigModel 厂商 OAuth 已下线——它们的授权页与用户信息都在第三方域名
 * （chat.z.ai / api.z.ai / bigmodel.cn），商业版账号体系只有平台账号（密码表单直连平台，不走 adapter）。
 * 因此这里不再创建任何厂商 adapter；保留函数与签名，调用方（OAuthService）无需分支改动：
 * 返回空列表即表示没有可启动的厂商 OAuth 流程。
 */
export function createOAuthProviderAdapters(
  _config: OAuthRuntimeConfig,
  _options: { apiClient?: ApiClient } = {},
): OAuthProviderAdapter[] {
  return [];
}

export type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";
