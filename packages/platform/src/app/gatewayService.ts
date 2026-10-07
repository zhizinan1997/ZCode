/**
 * 模型网关。
 *
 * 这是商业模式的强制点：上游 API key 只在这里使用，余额与套餐资格只在这里判定，
 * 用量的权威记录只在这里产生。客户端可以被修改，所以任何限制都不能只放在客户端。
 *
 * 一次请求的完整链路：
 *   验令牌（路由层完成）→ 找 provider → 解析模型与 max_tokens → 套餐资格
 *   → 可用余额 ≥ 预扣 → 写 reserved 记录 → 转发上游 → 计量
 *   → 结算（套餐额度优先，余额兜底）→ 写流水
 *
 * 幂等：request_id 同时是 usage_records 主键与 ledger 的唯一索引；
 * settle 只对 reserved 行生效，重试不会重复扣费。
 */
import {
  buildUpstreamUrl,
  readRequestBodyModel,
  readRequestedMaxOutputTokens,
  resolveUpstreamPath,
} from "../domain/gateway.js";
import { estimateReserveMicros } from "../domain/billing.js";
import { PlatformError } from "../domain/errors.js";
import { computeTokenCostMicros, type ModelPrice, type TokenUsage } from "../domain/money.js";
import {
  EMPTY_PRICE,
  REQUEST_ID_HEADER,
  STALE_RESERVATION_MS,
  buildUpstreamHeaders,
  filterResponseHeaders,
  jsonError,
} from "./gatewayWire.js";
import {
  EMPTY_USAGE,
  createSseUsageAccumulator,
  readUsageFromJson,
} from "../domain/usageParsing.js";
import type { BillingService } from "./billingService.js";
import type {
  GatewayProviderRepository,
  ModelPriceRepository,
  UpstreamTransport,
  UsageRepository,
} from "./ports.js";

export interface GatewayRequestInput {
  readonly userId: string;
  readonly providerId: string;
  readonly method: string;
  readonly requestPath: string;
  readonly search: string;
  readonly headers: Headers;
  readonly bodyText: string | null;
}

export interface GatewayService {
  handle(input: GatewayRequestInput): Promise<Response>;
  /** 释放因进程崩溃而滞留在 reserved 的预扣，避免余额被永久占用。 */
  recoverStaleReservations(): Promise<number>;
}

export function createGatewayService(deps: {
  readonly providers: GatewayProviderRepository;
  readonly prices: ModelPriceRepository;
  readonly billing: BillingService;
  readonly usage: UsageRepository;
  readonly transport: UpstreamTransport;
  readonly now: () => number;
  readonly newRequestId: () => string;
  /** 单次请求的输出上限；0 表示不限制。用于限制单次敞口。 */
  readonly outputTokenCap: number;
}): GatewayService {
  function readRequestId(headers: Headers): string {
    const provided = headers.get(REQUEST_ID_HEADER)?.trim();
    return provided && provided.length <= 200 ? provided : deps.newRequestId();
  }

  async function resolvePrice(modelId: string | null): Promise<ModelPrice> {
    if (!modelId) {
      return EMPTY_PRICE;
    }
    const record = await deps.prices.findByModelId(modelId);
    return record ?? EMPTY_PRICE;
  }

  /**
   * 结算并写账。
   *
   * `settle` 返回 false 表示该请求已结算过（重试或并发重复回调），此时绝不能再记账。
   * 结算异常向上抛，由调用方决定是兜底释放预扣还是保留——但不会改变已返回给客户端的响应：
   * 上游费用已经发生，不能因为记账失败破坏用户的响应。
   */
  async function settleUsage(input: {
    requestId: string;
    userId: string;
    usage: TokenUsage;
    price: ModelPrice;
    httpStatus: number | null;
    errorMessage: string | null;
    status?: "ok" | "upstream_error";
  }): Promise<void> {
    const costMicros = computeTokenCostMicros(input.usage, input.price);
    const settled = await deps.usage.settle({
      requestId: input.requestId,
      usage: input.usage,
      costMicros,
      status:
        input.status ??
        (input.httpStatus !== null && input.httpStatus >= 400 ? "upstream_error" : "ok"),
      httpStatus: input.httpStatus,
      errorMessage: input.errorMessage,
      now: deps.now(),
    });
    if (!settled || costMicros <= 0) {
      return;
    }
    await deps.billing.chargeUsage({
      userId: input.userId,
      requestId: input.requestId,
      costMicros,
    });
  }

  async function recordRejected(input: {
    requestId: string;
    userId: string;
    providerId: string;
    modelId: string | null;
    httpStatus: number;
    message: string;
  }): Promise<void> {
    // 被拒的请求也留痕：管理员排查"用户为什么调不动"时需要看到它们。
    // 它们没有产生上游费用，因此记为 0 费用并直接进入 rejected 终态。
    try {
      await deps.usage.insertReservation({
        requestId: input.requestId,
        userId: input.userId,
        providerId: input.providerId,
        modelId: input.modelId,
        costMicros: 0,
        httpStatus: input.httpStatus,
        durationMs: null,
        now: deps.now(),
      });
      await deps.usage.settle({
        requestId: input.requestId,
        usage: EMPTY_USAGE,
        costMicros: 0,
        status: "rejected",
        httpStatus: input.httpStatus,
        errorMessage: input.message,
        now: deps.now(),
      });
    } catch {
      // 留痕失败不能改变对客户端的拒绝结果。
    }
  }

  return {
    async handle(input) {
      const startedAt = deps.now();
      const requestId = readRequestId(input.headers);

      const provider = await deps.providers.findById(input.providerId);
      if (!provider || !provider.enabled) {
        return jsonError(
          404,
          "provider_not_found",
          `上游 provider 不存在或已停用：${input.providerId}`,
        );
      }
      const upstreamPath = resolveUpstreamPath({
        requestPath: input.requestPath,
        providerId: input.providerId,
      });
      if (upstreamPath === null) {
        return jsonError(404, "path_not_found", "网关路径不匹配");
      }

      let parsedBody: unknown = null;
      if (input.bodyText) {
        try {
          parsedBody = JSON.parse(input.bodyText);
        } catch {
          return jsonError(400, "invalid_request", "请求体不是合法 JSON");
        }
      }
      const modelId = readRequestBodyModel(parsedBody);
      const requestedMaxOutputTokens = readRequestedMaxOutputTokens(parsedBody);

      try {
        await deps.billing.assertModelEntitled({ userId: input.userId, modelId });
      } catch (error) {
        const platformError = error instanceof PlatformError ? error : null;
        const status = platformError?.status ?? 403;
        const message = platformError?.message ?? "套餐不允许该模型";
        await recordRejected({
          requestId,
          userId: input.userId,
          providerId: provider.id,
          modelId,
          httpStatus: status,
          message,
        });
        return jsonError(status, platformError?.code ?? "model_not_entitled", message);
      }

      const price = await resolvePrice(modelId);
      const reserveMicros = estimateReserveMicros({
        price,
        requestedMaxOutputTokens,
        outputTokenCap: deps.outputTokenCap,
      });
      const available = await deps.billing.getAvailableMicros(input.userId);
      if (available < reserveMicros) {
        const message = "余额不足，请充值后再试";
        await recordRejected({
          requestId,
          userId: input.userId,
          providerId: provider.id,
          modelId,
          httpStatus: 402,
          message,
        });
        return jsonError(402, "insufficient_balance", message);
      }

      const reserved = await deps.usage.insertReservation({
        requestId,
        userId: input.userId,
        providerId: provider.id,
        modelId,
        costMicros: reserveMicros,
        httpStatus: null,
        durationMs: null,
        now: startedAt,
      });
      if (!reserved) {
        // 幂等冲突：同一个 request_id 已经处理过。不能继续转发，否则会重复计费；
        // 也不能当成数据库故障，这是客户端重试可以预期的结果。
        return jsonError(
          409,
          "duplicate_request",
          `请求 ${requestId} 已处理过，请使用新的请求 id 重试`,
        );
      }

      const upstreamUrl = `${buildUpstreamUrl(provider.upstreamBaseUrl, upstreamPath)}${input.search}`;
      let upstreamResponse: Response;
      try {
        upstreamResponse = await deps.transport.forward({
          url: upstreamUrl,
          method: input.method,
          headers: buildUpstreamHeaders({ clientHeaders: input.headers, provider }),
          body: input.bodyText,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await settleUsage({
          requestId,
          userId: input.userId,
          usage: EMPTY_USAGE,
          price,
          httpStatus: 502,
          errorMessage: `转发上游失败：${message}`,
        });
        return jsonError(502, "upstream_unreachable", `无法连接上游服务：${message}`);
      }

      const responseHeaders = filterResponseHeaders(upstreamResponse.headers);
      // 把 requestId 回给客户端：出问题时用户能直接报这个 id 给管理员排查。
      responseHeaders.set("x-zcode-request-id", requestId);

      const contentType = upstreamResponse.headers.get("content-type") ?? "";
      const isEventStream = contentType.includes("text/event-stream");

      if (isEventStream && upstreamResponse.body) {
        // 流式：必须 tee——一边把字节给客户端，一边解析 SSE 里的用量。
        // 等流结束再决定是否转发就太晚了，上游费用那时已经发生。
        const [toClient, toMeter] = upstreamResponse.body.tee();
        const accumulator = createSseUsageAccumulator(provider.protocol);
        void (async () => {
          const reader = toMeter.getReader();
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              accumulator.push(decoder.decode(value, { stream: true }));
            }
          } catch {
            // 客户端断开或上游中断：仍按已解析到的用量结算，不足部分由预扣兜住。
          } finally {
            try {
              await settleUsage({
                requestId,
                userId: input.userId,
                usage: accumulator.result(),
                price,
                httpStatus: upstreamResponse.status,
                errorMessage: null,
              });
            } catch {
              // 结算失败时保留 reserved 记录，由 recoverStaleReservations 兜底释放，
              // 避免因为一次记账异常把用户余额永久扣住。
            }
          }
        })();
        return new Response(toClient, {
          status: upstreamResponse.status,
          headers: responseHeaders,
        });
      }

      const text = await upstreamResponse.text();
      let parsedResponse: unknown = null;
      try {
        parsedResponse = JSON.parse(text);
      } catch {
        parsedResponse = null;
      }
      await settleUsage({
        requestId,
        userId: input.userId,
        usage: readUsageFromJson(provider.protocol, parsedResponse),
        price,
        httpStatus: upstreamResponse.status,
        errorMessage: upstreamResponse.status >= 400 ? text.slice(0, 500) : null,
      });
      return new Response(text, { status: upstreamResponse.status, headers: responseHeaders });
    },

    async recoverStaleReservations() {
      const now = deps.now();
      return await deps.usage.releaseStaleReservations({
        olderThan: now - STALE_RESERVATION_MS,
        now,
      });
    },
  };
}
