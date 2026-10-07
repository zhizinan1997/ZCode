/**
 * 平台网关鉴权包装。
 *
 * 背景：平台下发的模型目录里，provider 的 `access.apiKey` 只是占位值——
 * 真正的上游 key 在服务端，客户端不该持有。因此发往平台网关的请求必须把凭据
 * 换成**用户自己的会话令牌**，由 host 通过进程环境注入（见 ZCODE_PLATFORM_GATEWAY_TOKEN_ENV_KEY）。
 *
 * 只为平台网关地址注入：用户自带 key 的 provider 仍按原样直连上游。
 * 没有令牌时不包装，行为与加入本层之前完全一致。
 */
import {
  resolveRuntimeZCodeEndpointOrigin,
  ZCODE_PLATFORM_GATEWAY_TOKEN_ENV_KEY,
} from "@zcode/shared";
import type { EnvRecord } from "./model-execution.js";

/** 与 packages/platform 的 GATEWAY_PATH_PREFIX 对应。 */
const GATEWAY_PATH_PREFIX = "/api/v1/gateway/";

const AUTHORIZATION_HEADER = "authorization";
const API_KEY_HEADER = "x-api-key";

type FetchLike = typeof globalThis.fetch;

function readRequestUrl(input: Parameters<FetchLike>[0]): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return null;
}

/** 是否发往平台网关：同源且落在网关路径前缀下。 */
export function isPlatformGatewayRequestUrl(requestUrl: string, gatewayOrigin: string): boolean {
  let parsed: URL;
  let origin: URL;
  try {
    parsed = new URL(requestUrl);
    origin = new URL(gatewayOrigin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin.origin) {
    return false;
  }
  return parsed.pathname.startsWith(GATEWAY_PATH_PREFIX);
}

function withGatewayAuthorization(input: Parameters<FetchLike>[0], init: Parameters<FetchLike>[1], token: string) {
  const headers = new Headers(
    init?.headers ??
      (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined),
  );
  headers.set(AUTHORIZATION_HEADER, `Bearer ${token}`);
  // 占位 key 不是凭据，留在请求里只会让网关多一个可能被误读的输入。
  headers.delete(API_KEY_HEADER);

  if (typeof Request !== "undefined" && input instanceof Request) {
    return { input: new Request(input, { headers }), init: undefined };
  }
  return { input, init: { ...init, headers } };
}

export function createPlatformGatewayAuthFetch(options: {
  env?: EnvRecord;
  fetch: FetchLike;
}): FetchLike {
  const token = options.env?.[ZCODE_PLATFORM_GATEWAY_TOKEN_ENV_KEY]?.trim();
  if (!token) {
    return options.fetch;
  }
  const gatewayOrigin = resolveRuntimeZCodeEndpointOrigin(options.env);

  return async (input, init) => {
    const requestUrl = readRequestUrl(input);
    if (!requestUrl || !isPlatformGatewayRequestUrl(requestUrl, gatewayOrigin)) {
      return await options.fetch(input, init);
    }
    const rewritten = withGatewayAuthorization(input, init, token);
    return await options.fetch(rewritten.input, rewritten.init);
  };
}
