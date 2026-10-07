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
