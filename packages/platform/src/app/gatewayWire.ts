/**
 * 网关的报头与响应构造（纯函数）。
 *
 * 单独成文件是因为这里的规则最容易出错又最容易被忽略：
 * 请求头只按白名单转发、认证头必须换掉、响应头里的编码字段要清掉。
 */
import type { GatewayProvider } from "../domain/gateway.js";

/** 客户端可携带的请求 id 头；带上它出问题时用户能直接把 id 报给管理员。 */
export const REQUEST_ID_HEADER = "x-zcode-request-id";

/** 预扣滞留多久算作崩溃遗留。正常转发不会超过这个量级。 */
export const STALE_RESERVATION_MS = 30 * 60 * 1000;

/**
 * 转发给上游的请求头白名单（审计#13）。
 *
 * 黑名单漏一个头就泄露一个头：cookie（会话）、user-agent、x-forwarded-for（客户端 IP）、
 * cf-*（边缘信息）、x-zcode-request-id（用户身份关联）都不是上游需要的，却会跟着请求出网。
 * 因此只放行协议本身需要的字段，其余一律不转发；连接级字段（host/content-length/
 * accept-encoding）也由 fetch 自己决定。
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
  // Anthropic 的协议版本与 beta 能力必须透传，否则上游会拒绝或降级。
  "anthropic-version",
  "anthropic-beta",
]);

/** 除精确匹配外还放行这些前缀的头（如 OpenAI 的 openai-beta / openai-organization）。 */
const FORWARDED_REQUEST_HEADER_PREFIXES = ["openai-"];

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
    const name = key.toLowerCase();
    const allowed =
      FORWARDED_REQUEST_HEADERS.has(name) ||
      FORWARDED_REQUEST_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (!allowed) {
      return;
    }
    headers[name] = value;
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
