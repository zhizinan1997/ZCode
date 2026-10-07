import type {
  OAuthCachedSessionRestoreResult,
  OAuthCallbackResult,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthSessionCallbackResult,
  OAuthStartResponse,
  UserInfo,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 认证服务
 *
 * 在 host process 中运行，负责登录流程的全部业务逻辑：
 * provider 管理、state 生命周期、token 交换、凭据存储。
 * 除厂商 OAuth 外，也承载平台账号的密码登录（见 loginWithPlatformAccount）。
 */
export interface IOAuthService {
  /** 获取可用 provider 列表（仅返回 enabled=true） */
  getProviders(): Promise<OAuthProviderMeta[]>;

  /**
   * 平台账号密码登录。
   *
   * 不走浏览器与 deep link：凭据由客户端表单提交，host 直接向平台后端换取会话并落盘。
   * 返回结构与 OAuth 回调成功一致，使 renderer 能复用同一套登录成功处理。
   */
  loginWithPlatformAccount(input: {
    email: string;
    password: string;
  }): Promise<OAuthSessionCallbackResult>;

  /** 获取当前 active provider */
  getActiveProvider(): Promise<OAuthProviderId | null>;

  /** 启动时从本地缓存恢复会话展示态：成功返回用户信息，不做远端 token 校验 */
  restoreCachedSession(): Promise<UserInfo | null>;

  /** 恢复本地展示态，并区分从未登录与 JWT 过期后需要重新认证。 */
  restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult>;

  /** 显式校验当前 provider 会话：成功返回用户信息，失败或过期返回 null */
  restoreSession(): Promise<UserInfo | null>;

  /**
   * 发起 OAuth：指定 provider，生成 state，返回 authorize URL
   * state 由 renderer 上报给 main process 用于 deep link 路由
   */
  startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse>;

  /** 使用后端短期 flow 发起 OAuth；当前仅 Z.AI 支持，其他 provider 保持原流程。 */
  startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse>;

  /** 查询当前后端 OAuth flow；未到查询时间、仍 pending 或没有 flow 时返回 null。 */
  pollPendingOAuth(): Promise<OAuthCallbackResult | null>;

  /**
   * 处理 OAuth 回调：校验 state；带 code 时换 token 并存凭据，只带归因参数时持久化归因信息
   * 已接收回调因取消或新 flow 失效时返回 null，由调用方静默忽略。
   * @param url - 完整 deep link URL
   */
  handleCallback(url: string): Promise<OAuthCallbackResult | null>;

  /**
   * 刷新 token
   * @param provider - 可选；不传时使用 active provider
   */
  refreshToken(provider?: OAuthProviderId): Promise<void>;

  /**
   * 登出 provider
   * @param provider - 可选；不传时登出 active provider
   */
  logout(provider?: OAuthProviderId): Promise<void>;

  /** 登出所有 provider */
  logoutAll(): Promise<void>;

  /**
   * 取消 pending OAuth
   * @param provider - 可选；不传时取消当前 pending
   */
  cancelPending(provider?: OAuthProviderId): Promise<void>;
}

export const IOAuthService = createServiceDescriptor<IOAuthService>(ServiceChannels.OAuth);
