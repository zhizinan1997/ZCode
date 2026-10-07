/**
 * 模型网关。
 *
 * 这是商业模式的强制点：上游 API key 只在这里使用，余额与套餐资格只在这里判定，
 * 用量的权威记录只在这里产生。客户端可以被修改，所以任何限制都不能只放在客户端。
 *
 * 一次请求的完整链路：
 *   验令牌（路由层完成）→ 找 provider → 路径白名单 → 解析模型与 max_tokens → 套餐资格
 *   → 查单价 → 原子预扣（可用额度判定 + 写 reserved 同一事务）→ 注入上游所需参数
 *   → 转发上游 → 计量 → 原子结算（状态改终态 + 套餐扣除 + 余额流水同一事务）
 *
 * 幂等：request_id 同时是 usage_records 主键与 ledger 的唯一索引；
 * settle 只对 reserved 行生效，重试不会重复扣费。
 */
import {
  buildUpstreamUrl,
  injectStreamUsageOption,
  readRequestBodyModel,
  readRequestedMaxOutputTokens,
  resolveGatewayEndpoint,
  resolveUpstreamPath,
} from "../domain/gateway.js";
import { estimateReserveMicros } from "../domain/billing.js";
import { PlatformError } from "../domain/errors.js";
import { type ModelPrice } from "../domain/money.js";
import {
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
import { recordRejectedUsage, settleGatewayUsage } from "./gatewayAccounting.js";
import type { BillingService } from "./billingService.js";
import type { GatewayProvider } from "../domain/gateway.js";
import type {
  GatewayProviderRepository,
  ModelPriceRepository,
  ModelPublishRepository,
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
  readonly publish: ModelPublishRepository;
  readonly billing: BillingService;
  readonly usage: UsageRepository;
  readonly transport: UpstreamTransport;
  readonly now: () => number;
  readonly newRequestId: () => string;
  /** 单次请求的输出上限；0 表示不限制。用于限制单次敞口。 */
  readonly outputTokenCap: number;
}): GatewayService {
  const accounting = { usage: deps.usage, now: deps.now };

  function readRequestId(headers: Headers): string {
    const provided = headers.get(REQUEST_ID_HEADER)?.trim();
    return provided && provided.length <= 200 ? provided : deps.newRequestId();
  }

  /**
   * 计费端点的单价；未配置或请求体没给 model 时返回 null（审计#4）。
   * 未配价按 0 计费等于平台替用户白付上游成本，调用方必须拒绝。
   */
  async function resolvePrice(modelId: string | null): Promise<ModelPrice | null> {
    if (!modelId) {
      return null;
    }
    return await deps.prices.findByModelId(modelId);
  }

  /** 辅助端点（models / count_tokens）：注入平台 key 转发，但完全不计费（审计#3）。 */
  async function forwardAuxiliary(input: {
    provider: GatewayProvider;
    upstreamPath: string;
    request: GatewayRequestInput;
    requestId: string;
  }): Promise<Response> {
    const url = `${buildUpstreamUrl(input.provider.upstreamBaseUrl, input.upstreamPath)}${input.request.search}`;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await deps.transport.forward({
        url,
        method: input.request.method,
        headers: buildUpstreamHeaders({
          clientHeaders: input.request.headers,
          provider: input.provider,
        }),
        body: input.request.bodyText,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonError(502, "upstream_unreachable", `无法连接上游服务：${message}`);
    }
    const headers = filterResponseHeaders(upstreamResponse.headers);
    headers.set("x-zcode-request-id", input.requestId);
    return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers });
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
      // 审计#3：只有白名单内的路径才转发，避免网关被当成访问上游任意 API 的跳板。
      const endpoint = resolveGatewayEndpoint(provider.protocol, upstreamPath);
      if (!endpoint) {
        return jsonError(404, "path_not_allowed", `网关不允许该上游路径：${upstreamPath}`);
      }
      if (!endpoint.billable) {
        return await forwardAuxiliary({
          provider,
          upstreamPath,
          request: input,
          requestId,
        });
      }

      let parsedBody: unknown = null;
      if (input.bodyText) {
        try {
          parsedBody = JSON.parse(input.bodyText);
        } catch {
          return jsonError(400, "invalid_request", "请求体不是合法 JSON");
        }
      }
      // 显示名映射（specs/platform/model-publish.md）：目录里发布的 modelId 是管理员配置的
      // 显示名，上游真实模型 ID 绝不进目录。这里按 (providerId, 显示名) 反查真实 ID 并改写
      // 请求体；查不到映射说明该模型不是通过发布功能下发的，保持原样透传，老客户端直发
      // 真实 ID 的行为不变。改写必须发生在套餐资格与计价之前——用量与单价都以真实 ID 记账。
      const requestedModelId = readRequestBodyModel(parsedBody);
      const upstreamModelId = requestedModelId
        ? await deps.publish.findUpstreamModelId(provider.id, requestedModelId)
        : null;
      let rewroteModel = false;
      if (upstreamModelId !== null && parsedBody && typeof parsedBody === "object") {
        (parsedBody as Record<string, unknown>)["model"] = upstreamModelId;
        rewroteModel = true;
      }
      const modelId = upstreamModelId ?? requestedModelId;
      const requestedMaxOutputTokens = readRequestedMaxOutputTokens(parsedBody);

      try {
        await deps.billing.assertModelEntitled({ userId: input.userId, modelId });
      } catch (error) {
        const platformError = error instanceof PlatformError ? error : null;
        const status = platformError?.status ?? 403;
        const message = platformError?.message ?? "套餐不允许该模型";
        await recordRejectedUsage(accounting, {
          requestId,
          userId: input.userId,
          providerId: provider.id,
          modelId,
          httpStatus: status,
          message,
        });
        return jsonError(status, platformError?.code ?? "model_not_entitled", message);
      }

      // 审计#4：计费端点必须有单价。没有单价就按 0 计费，等于平台替用户白付上游成本。
      const price = await resolvePrice(modelId);
      if (!price) {
        const message = modelId
          ? `模型 ${modelId} 没有配置单价，请联系管理员`
          : "计费端点必须在请求体中指定 model";
        await recordRejectedUsage(accounting, {
          requestId,
          userId: input.userId,
          providerId: provider.id,
          modelId,
          httpStatus: 403,
          message,
        });
        return jsonError(403, "model_not_priced", message);
      }

      const reserveMicros = estimateReserveMicros({
        price,
        requestedMaxOutputTokens,
        outputTokenCap: deps.outputTokenCap,
        // 审计#9：输入部分按请求体字节数粗估；只按输出估算会让长输入请求的预扣远低于实际费用。
        requestBytes: input.bodyText === null ? 0 : Buffer.byteLength(input.bodyText, "utf8"),
      });

      // 审计#7：可用额度判定与预扣写入放进 sqlite 层同一个 BEGIN IMMEDIATE 事务，
      // 并发请求不可能同时通过准入检查后一起超支。
      const reservation = await deps.usage.reserveForRequest({
        requestId,
        userId: input.userId,
        providerId: provider.id,
        modelId,
        costMicros: reserveMicros,
        httpStatus: null,
        durationMs: null,
        now: startedAt,
      });
      if (reservation === "duplicate") {
        // 幂等冲突：同一个 request_id 已经处理过。不能继续转发，否则会重复计费；
        // 也不能当成数据库故障，这是客户端重试可以预期的结果。
        return jsonError(
          409,
          "duplicate_request",
          `请求 ${requestId} 已处理过，请使用新的请求 id 重试`,
        );
      }
      if (reservation === "insufficient_balance") {
        const message = "余额不足，请充值后再试";
        await recordRejectedUsage(accounting, {
          requestId,
          userId: input.userId,
          providerId: provider.id,
          modelId,
          httpStatus: 402,
          message,
        });
        return jsonError(402, "insufficient_balance", message);
      }

      const upstreamUrl = `${buildUpstreamUrl(provider.upstreamBaseUrl, upstreamPath)}${input.search}`;
      // 审计#2：OpenAI 兼容上游默认不回流式用量，转发前显式请求 stream_options.include_usage，
      // 否则流式请求只能靠"用量缺失"兜底，按实际消耗计费就无从谈起。
      const injectedBody = injectStreamUsageOption({
        protocol: provider.protocol,
        upstreamPath,
        body: parsedBody,
      });
      // 优先用注入后的 body；没有注入但改写过 model 时必须序列化改写后的 body——
      // 原样转发 input.bodyText 会把显示名发给上游，上游会 404。
      const forwardBody = injectedBody
        ? JSON.stringify(injectedBody)
        : rewroteModel
          ? JSON.stringify(parsedBody)
          : input.bodyText;
      let upstreamResponse: Response;
      try {
        upstreamResponse = await deps.transport.forward({
          url: upstreamUrl,
          method: input.method,
          headers: buildUpstreamHeaders({ clientHeaders: input.headers, provider }),
          body: forwardBody,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await settleGatewayUsage(accounting, {
            requestId,
            userId: input.userId,
            usage: EMPTY_USAGE,
            price,
            reserveMicros,
            httpStatus: 502,
            errorMessage: `转发上游失败：${message}`,
          });
        } catch {
          // 结算失败时整笔回滚，记录保持在 reserved，由滞留预扣释放兜底。
        }
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
              await settleGatewayUsage(accounting, {
                requestId,
                userId: input.userId,
                usage: accumulator.result(),
                price,
                reserveMicros,
                httpStatus: upstreamResponse.status,
                errorMessage: null,
              });
            } catch {
              // 结算是单事务，失败时整笔回滚，记录仍在 reserved（预扣继续占用额度），
              // 由 recoverStaleReservations 兜底释放；这里不能改变已经返回给客户端的流。
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
      try {
        await settleGatewayUsage(accounting, {
          requestId,
          userId: input.userId,
          usage: readUsageFromJson(provider.protocol, parsedResponse),
          price,
          reserveMicros,
          httpStatus: upstreamResponse.status,
          errorMessage: upstreamResponse.status >= 400 ? text.slice(0, 500) : null,
        });
      } catch {
        // 记账失败不改变上游已经产生的响应：整笔事务已回滚，记录仍在 reserved，
        // 由滞留预扣释放兜底，不给用户一个上游成功却 500 的结果。
      }
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
