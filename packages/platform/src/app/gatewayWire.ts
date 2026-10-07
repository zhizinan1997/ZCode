/**
 * 网关的报头与响应构造（纯函数）。
 *
 * 单独成文件是因为这里的规则最容易出错又最容易被忽略：
 * 逐跳头不能转发、认证头必须换掉、压缩头必须清掉（否则流式解析会拿到二进制）。
 */
import type { GatewayProvider } from "../domain/gateway.js";
import type { ModelPrice } from "../domain/money.js";

export const EMPTY_PRICE: ModelPrice = {
  inputMicrosPerMillion: 0,
  outputMicrosPerMillion: 0,
  cacheReadMicrosPerMillion: 0,
  cacheWriteMicrosPerMillion: 0,
};

/** 客户端可携带的请求 id 头；带上它出问题时用户能直接把 id 报给管理员。 */
export const REQUEST_ID_HEADER = "x-zcode-request-id";

/** 预扣滞留多久算作崩溃遗留。正常转发不会超过这个量级。 */
export const STALE_RESERVATION_MS = 30 * 60 * 1000;

/** 不转发给上游的请求头：连接级字段由 fetch 决定，认证字段由网关换成平台 key。 */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "authorization",
  "x-api-key",
  // 要求上游返回未压缩内容：网关要解析 SSE 流，压缩会破坏按文本切分的事件边界。
  "accept-encoding",
]);

/** 不转发给客户端的响应头：内容已被 fetch 解压，长度与编码不再成立。 */
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

export function buildUpstreamHeaders(input: {
  clientHeaders: Headers;
  provider: GatewayProvider;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  input.clientHeaders.forEach((value, key) => {
    if (DROPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      return;
    }
    headers[key] = value;
  });
  const key = input.provider.apiKey;
  if (input.provider.protocol === "anthropic") {
    headers["x-api-key"] = key;
  } else {
    headers["authorization"] = `Bearer ${key}`;
  }
  return headers;
}

export function filterResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      return;
    }
    headers.set(key, value);
  });
  return headers;
}

export function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
