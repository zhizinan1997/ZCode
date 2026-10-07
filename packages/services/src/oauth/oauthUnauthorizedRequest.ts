import type { ICredentialService } from "#src/credential/credential.js";

// 这里只判定候选请求；实际退出须由 OAuthService 在会话变更队列内复核，不能依赖异步旧快照。
//
// 商业版域名边界：厂商 OAuth 已下线，客户端不再持有/请求厂商 userinfo 域名；
// 这里只识别平台会话令牌（zcodejwttoken）对应的请求。
export async function isCurrentOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return false;
  const currentJwt = (await options.credentialService.load("zcodejwttoken"))?.trim() ?? "";
  return Boolean(currentJwt) && authorization === `Bearer ${currentJwt}`;
}
