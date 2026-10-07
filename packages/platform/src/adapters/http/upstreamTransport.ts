/**
 * 上游转发（fetch 实现）。
 *
 * 只有这一处会用平台持有的上游 key 发起外呼。走它而不是让客户端直连，
 * 是"计量与限额只在服务端判定"这条约束的物理基础。
 *
 * 超时语义是"无数据超时"（审计#14）：等待响应头与等待 body 分片共用同一个计时器，
 * 每收到一个分片就重置。10 分钟总时长上限会把长回答掐断，因此不再保留总上限：
 * 只要上游还在出数据，请求就不该被中止；真正挂住不动的上游才会被 abort。
 */
import type { UpstreamForwardRequest, UpstreamTransport } from "../../app/ports.js";

export function createFetchUpstreamTransport(options: {
  /** 无数据超时（毫秒）；等待响应头与等待分片共用。 */
  readonly idleTimeoutMs: number;
}): UpstreamTransport {
  return {
    async forward(request: UpstreamForwardRequest): Promise<Response> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const clearTimer = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const resetTimer = () => {
        clearTimer();
        timer = setTimeout(() => {
          controller.abort(new Error(`上游 ${options.idleTimeoutMs}ms 没有返回数据`));
        }, options.idleTimeoutMs);
      };

      // 先武装计时器再 fetch：等待响应头同样属于"没有数据"。
      resetTimer();
      let response: Response;
      try {
        response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        clearTimer();
        throw error;
      }

      if (!response.body) {
        clearTimer();
        return response;
      }

      // 在 tee 之前包一层：每读到一帧数据就重置计时器，流结束或被取消时清掉。
      // abort 会让读取以错误失败，错误原样传给消费方（网关/客户端），不会被吞掉。
      const reader = response.body.getReader();
      const wrapped = new ReadableStream<Uint8Array>({
        async pull(sink) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              clearTimer();
              sink.close();
              return;
            }
            resetTimer();
            sink.enqueue(value);
          } catch (error) {
            clearTimer();
            sink.error(error);
          }
        },
        async cancel(reason) {
          clearTimer();
          await reader.cancel(reason);
        },
      });
      return new Response(wrapped, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}
