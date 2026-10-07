/**
 * 网关领域类型（纯逻辑）。
 *
 * 客户端把平台管理的 provider 的 baseUrl 指向 `<平台>/api/v1/gateway/<providerId>`，
 * 网关据此把请求转发到真正的上游。这样上游 API key 只存在于服务端，
 * 计量与限额也只有一个强制点。
 */

export const GATEWAY_PROTOCOLS = ["anthropic", "openai", "openai-compatible"] as const;
export type GatewayProtocol = (typeof GATEWAY_PROTOCOLS)[number];

export interface GatewayProvider {
  readonly id: string;
  readonly label: string;
  readonly upstreamBaseUrl: string;
  readonly apiKey: string;
  readonly protocol: GatewayProtocol;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function isGatewayProtocol(value: unknown): value is GatewayProtocol {
  return typeof value === "string" && (GATEWAY_PROTOCOLS as readonly string[]).includes(value);
}

/** 网关自身的路径前缀；客户端 baseUrl 会指向它。 */
export const GATEWAY_PATH_PREFIX = "/api/v1/gateway";

/**
 * 各协议放行的上游路径（审计#3）。
 *
 * 没有白名单时网关是任意路径的透传代理，客户端可以借它调用上游的任何 API。
 * 白名单之外的路径一律 404，不转发。
 */
// OpenAI 兼容客户端常按 SDK 惯例把 base_url 配到 `.../v1`，同一端点的请求路径会带 /v1 前缀；
// 两种写法都放行（路径原样转发，最终地址由上游 baseUrl 决定），用平台 API Key 的第三方
// 客户端不必为了网关改写自己的 base_url。
const OPENAI_CHAT_COMPLETIONS_PATHS = ["/chat/completions", "/v1/chat/completions"] as const;
const OPENAI_RESPONSES_PATHS = ["/responses", "/v1/responses"] as const;
const OPENAI_MODELS_PATHS = ["/models", "/v1/models"] as const;

export const GATEWAY_ALLOWED_PATHS: Record<GatewayProtocol, readonly string[]> = {
  anthropic: ["/v1/messages", "/v1/messages/count_tokens", "/v1/models"],
  openai: [...OPENAI_CHAT_COMPLETIONS_PATHS, ...OPENAI_RESPONSES_PATHS, ...OPENAI_MODELS_PATHS],
  "openai-compatible": [
    ...OPENAI_CHAT_COMPLETIONS_PATHS,
    ...OPENAI_RESPONSES_PATHS,
    ...OPENAI_MODELS_PATHS,
  ],
};

/** 计费端点：必须解析 model、查单价、预扣与结算。其余放行路径是辅助端点。 */
const BILLABLE_PATHS: ReadonlySet<string> = new Set([
  "/v1/messages",
  ...OPENAI_CHAT_COMPLETIONS_PATHS,
  ...OPENAI_RESPONSES_PATHS,
]);

export interface GatewayEndpoint {
  readonly path: string;
  /** true 表示按 token 计费的对话端点；false 表示不计费的辅助端点（models/count_tokens）。 */
  readonly billable: boolean;
}

/** 路径白名单判定；不在白名单内返回 null，由调用方返回 404 path_not_allowed。 */
export function resolveGatewayEndpoint(
  protocol: GatewayProtocol,
  upstreamPath: string,
): GatewayEndpoint | null {
  if (!GATEWAY_ALLOWED_PATHS[protocol].includes(upstreamPath)) {
    return null;
  }
  return { path: upstreamPath, billable: BILLABLE_PATHS.has(upstreamPath) };
}

/**
 * 上游请求路径。
 *
 * 客户端拿到的是 `.../api/v1/gateway/<providerId>`，SDK 会在其后拼 `/v1/messages`
 * 之类的路径，因此这里把前缀与 providerId 剥掉，剩余路径原样拼到上游 baseUrl 上。
 */
export function resolveUpstreamPath(options: {
  requestPath: string;
  providerId: string;
}): string | null {
  const prefix = `${GATEWAY_PATH_PREFIX}/${options.providerId}`;
  if (!options.requestPath.startsWith(prefix)) {
    return null;
  }
  const rest = options.requestPath.slice(prefix.length);
  if (!rest) {
    return "/";
  }
  return rest.startsWith("/") ? rest : `/${rest}`;
}

export function buildUpstreamUrl(baseUrl: string, upstreamPath: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalizedBase}${upstreamPath}`;
}

/**
 * 请求体里声明的输出上限。
 *
 * 两个协议都用 `max_tokens`；解析失败时返回 null，让调用方走默认预扣估算，
 * 而不是把请求判为非法——上游自己会给出更准确的错误。
 */
export function readRequestedMaxOutputTokens(body: unknown): number | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const value = (body as Record<string, unknown>)["max_tokens"];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function readRequestBodyModel(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const value = (body as Record<string, unknown>)["model"];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 从请求路径推断计价用的模型名不可靠，模型一律以请求体的 model 字段为准。 */
export function readStreamFlag(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  return (body as Record<string, unknown>)["stream"] === true;
}

/**
 * 为 OpenAI 兼容的流式对话请求补上 `stream_options.include_usage`（审计#2）。
 *
 * 上游默认不在流末尾返回 usage，只有显式请求才带；不注入的话流式请求拿到 0 用量，
 * 只能走"用量缺失"兜底，无法按实际消耗计费。已有该字段时保留其它字段不动。
 * 返回 null 表示不需要改写（非 OpenAI 协议、非对话端点、非流式或已请求过）。
 */
export function injectStreamUsageOption(options: {
  protocol: GatewayProtocol;
  upstreamPath: string;
  body: unknown;
}): Record<string, unknown> | null {
  if (
    options.protocol === "anthropic" ||
    !(OPENAI_CHAT_COMPLETIONS_PATHS as readonly string[]).includes(options.upstreamPath)
  ) {
    return null;
  }
  const body = options.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (record["stream"] !== true) {
    return null;
  }
  const existing = record["stream_options"];
  const streamOptions =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  if (streamOptions["include_usage"] === true) {
    return null;
  }
  return { ...record, stream_options: { ...streamOptions, include_usage: true } };
}
