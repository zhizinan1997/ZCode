/**
 * 上游转发（fetch 实现）。
 *
 * 只有这一处会用平台持有的上游 key 发起外呼。走它而不是让客户端直连，
 * 是"计量与限额只在服务端判定"这条约束的物理基础。
 */
import type { UpstreamForwardRequest, UpstreamTransport } from "../../app/ports.js";

export function createFetchUpstreamTransport(options: {
  /** 单次请求（含流式响应）的总超时；防止上游挂住导致预扣长期占用。 */
  readonly timeoutMs: number;
}): UpstreamTransport {
  return {
    async forward(request: UpstreamForwardRequest): Promise<Response> {
      return await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    },
  };
}
