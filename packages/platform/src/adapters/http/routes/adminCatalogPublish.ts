/**
 * 模型发布相关接口的辅助函数（从 adminCatalog 拆出：max-lines 架构约束）。
 *
 * 从上游拉取模型列表（审计#25）：`redirect: "manual"`，3xx 一律拒绝跟随。
 * 发布设置的校验与推送在 modelPublishService（specs/platform/model-publish.md）。
 */
import { PlatformError } from "../../../domain/errors.js";

/** 拉取上游模型列表的单次超时：模型列表是轻请求，不需要网关转发那种长超时。 */
const UPSTREAM_FETCH_TIMEOUT_MS = 15_000;

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

function parseUpstreamModelIds(payload: unknown): string[] {
  const list = Array.isArray(payload)
    ? payload
    : (payload as Record<string, unknown> | null)?.["data"];
  if (!Array.isArray(list)) {
    throw new PlatformError(
      "invalid_request",
      "无法从上游响应解析模型列表（期望 { data: [{ id }] }）",
    );
  }
  const ids = list
    .map((item) => {
      const id = (item as Record<string, unknown> | null)?.["id"];
      return typeof id === "string" ? id.trim() : "";
    })
    .filter(Boolean);
  return [...new Set(ids)];
}

export interface UpstreamModelFetchResult {
  readonly models: readonly string[];
  /** openai 系上游缺 /v1 时回退 /models 成功后提示管理员纠正 baseUrl。 */
  readonly suggestedBaseUrl: string | null;
}

/**
 * 从上游拉取模型列表。
 *
 * 审计#25：fetch 必须 `redirect: "manual"`，响应为 3xx 时直接报错拒绝——跟随重定向会把
 * x-api-key / Authorization 带到重定向目标站点，等于把上游密钥泄露给第三方。
 * 错误信息只含状态码，绝不含 API key。
 */
export async function fetchUpstreamModelIds(options: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly protocol: string;
  readonly fetchImpl: typeof fetch;
}): Promise<UpstreamModelFetchResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.protocol === "anthropic") {
    headers["x-api-key"] = options.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["authorization"] = `Bearer ${options.apiKey}`;
  }
  // openai 系上游的 baseUrl 可能已带 /v1、/v4 等版本段，先试 /v1/models 再退 /models。
  const paths = options.protocol === "anthropic" ? ["/v1/models"] : ["/v1/models", "/models"];
  const trimmedBase = options.baseUrl.replace(/\/+$/, "");
  let lastStatus = 0;
  for (const path of paths) {
    const response = await options.fetchImpl(joinUrl(trimmedBase, path), {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new PlatformError(
        "invalid_request",
        `上游返回了重定向（状态码 ${response.status}），已拒绝跟随：跟随会把上游 API key 带到重定向目标站点。` +
          "请把该上游的 baseUrl 直接改成最终地址后重试。",
      );
    }
    if (response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new PlatformError("invalid_request", "上游响应不是合法 JSON", { cause: error });
      }
      const suggestedBaseUrl =
        path === "/models" && !/\/v\d+$/.test(trimmedBase) ? joinUrl(trimmedBase, "/v1") : null;
      return { models: parseUpstreamModelIds(payload), suggestedBaseUrl };
    }
    lastStatus = response.status;
  }
  throw new PlatformError("invalid_request", `上游返回状态码 ${lastStatus}，无法获取模型列表`);
}
