import type { OAuthProviderId } from "@zcode/shared";

/** Provider 运行时配置（仅 host process 可见） */
export interface OAuthProviderRuntimeConfig {
  id: OAuthProviderId;
  displayName: string;
  enabled: boolean;
  order: number;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  appId: string;
  redirectUri: string;
  businessLoginUrl?: string;
  appSecret?: string;
}

/** OAuth 全局运行时配置 */
export interface OAuthRuntimeConfig {
  providers: OAuthProviderRuntimeConfig[];
}

/**
 * 从运行时环境变量生成 OAuth 配置。
 *
 * 注意：这里只能在 host process 使用，避免把敏感配置暴露给 renderer。
 */
export function createOAuthRuntimeConfig(
  _env: NodeJS.ProcessEnv = process.env,
): OAuthRuntimeConfig {
  // 商业版域名边界：不再注册 Z.ai / BigModel 厂商 OAuth provider。
  //
  // 厂商 OAuth 的授权与用户信息端点都在第三方域名（chat.z.ai / api.z.ai / bigmodel.cn），
  // 商业版账号体系只有平台账号（PLATFORM_PROVIDER_ID，密码表单直连平台）。
  // 这里返回空列表后，startOAuth("zai" | "bigmodel") 会因找不到 adapter 直接报错，
  // 客户端不会再有任何路径打开厂商授权页。
  return {
    providers: [],
  };
}
