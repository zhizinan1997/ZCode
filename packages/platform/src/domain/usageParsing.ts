/**
 * 上游响应的用量解析（纯逻辑）。
 *
 * 两种协议族的字段名不同，且流式与非流式的承载方式也不同：
 * - Anthropic：`usage.input_tokens` / `output_tokens`；
 *   缓存命中是 `cache_read_input_tokens`，缓存写入是 `cache_creation_input_tokens`。
 *   流式下输入用量在 `message_start` 事件里，输出用量在最后的 `message_delta` 里累计。
 * - OpenAI 兼容：`usage.prompt_tokens` / `completion_tokens`；
 *   缓存命中在 `prompt_tokens_details.cached_tokens`（Responses API 在 `input_tokens_details`）。
 *   流式下只有显式请求了 usage 才会在最后带一个 usage 块，缺失时按未知处理；
 *   Responses API 的用量在 `response.completed` 事件的 `payload.response.usage`。
 *
 * 解析必须宽松：上游字段缺失或改名不应让网关报错，宁可记为未知用量（0）。
 */
import type { TokenUsage } from "./money.js";
import type { GatewayProtocol } from "./gateway.js";

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Number.isSafeInteger(value) ? value : Math.trunc(value);
}

function readAnthropicUsage(usage: Record<string, unknown>): TokenUsage {
  return {
    inputTokens: readNonNegativeInt(usage["input_tokens"]),
    outputTokens: readNonNegativeInt(usage["output_tokens"]),
    cacheReadTokens: readNonNegativeInt(usage["cache_read_input_tokens"]),
    cacheWriteTokens: readNonNegativeInt(usage["cache_creation_input_tokens"]),
  };
}

function readOpenAiUsage(usage: Record<string, unknown>): TokenUsage {
  // Chat Completions 用 prompt_tokens_details，Responses API 用 input_tokens_details；
  // 两处的 cached_tokens 都是缓存命中档，漏掉会把缓存读按全价输入计费。
  const details = isRecord(usage["prompt_tokens_details"])
    ? usage["prompt_tokens_details"]
    : isRecord(usage["input_tokens_details"])
      ? usage["input_tokens_details"]
      : null;
  const cachedFromDetails = details ? readNonNegativeInt(details["cached_tokens"]) : 0;
  const cached = cachedFromDetails || readNonNegativeInt(usage["cache_read_input_tokens"]);
  return {
    inputTokens: readNonNegativeInt(usage["prompt_tokens"] ?? usage["input_tokens"]),
    outputTokens: readNonNegativeInt(usage["completion_tokens"] ?? usage["output_tokens"]),
    cacheReadTokens: cached,
    cacheWriteTokens: readNonNegativeInt(usage["cache_creation_input_tokens"]),
  };
}

/**
 * 取 OpenAI 兼容响应里的 usage 块。
 *
 * Chat Completions 在顶层 `usage`；Responses API（含流式的 `response.completed` 事件）
 * 把它放在 `payload.response.usage` 里，两处都要认，否则 Responses 请求会漏计量（审计#2）。
 */
function readOpenAiUsageBlock(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(payload["usage"])) {
    return payload["usage"];
  }
  const response = payload["response"];
  if (isRecord(response) && isRecord(response["usage"])) {
    return response["usage"];
  }
  return null;
}

export function readUsageFromJson(protocol: GatewayProtocol, payload: unknown): TokenUsage {
  if (!isRecord(payload)) {
    return EMPTY_USAGE;
  }
  if (protocol === "anthropic") {
    return isRecord(payload["usage"]) ? readAnthropicUsage(payload["usage"]) : EMPTY_USAGE;
  }
  const usage = readOpenAiUsageBlock(payload);
  return usage ? readOpenAiUsage(usage) : EMPTY_USAGE;
}

type UsageReducer = (current: TokenUsage, next: TokenUsage) => TokenUsage;

/**
 * 取两段用量里更完整的那个。
 *
 * 流式下同一项可能在多个事件里出现（例如 Anthropic 的 input 在 message_start、
 * output 在 message_delta），且后到的可能只带部分字段。逐项取最大值可以避免
 * "后一个事件把前一个事件的输入用量覆盖成 0"这类丢失。
 */
const mergeUsage: UsageReducer = (current, next) => ({
  inputTokens: Math.max(current.inputTokens, next.inputTokens),
  outputTokens: Math.max(current.outputTokens, next.outputTokens),
  cacheReadTokens: Math.max(current.cacheReadTokens, next.cacheReadTokens),
  cacheWriteTokens: Math.max(current.cacheWriteTokens, next.cacheWriteTokens),
});

interface SseEvent {
  event: string | null;
  data: string;
}

/** 极简 SSE 解析：只需要 event 名与 data 行，忽略其余字段。 */
function parseSseEvents(chunk: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of chunk.split(/\r?\n\r?\n/)) {
    const trimmed = block.trim();
    if (!trimmed) {
      continue;
    }
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join("\n") });
    }
  }
  return events;
}

/** 从一段 SSE 原始文本里解析用量；已按协议区分事件名。 */
function readUsageFromSseChunk(protocol: GatewayProtocol, chunk: string): TokenUsage {
  let merged = EMPTY_USAGE;
  for (const event of parseSseEvents(chunk)) {
    if (event.data === "[DONE]") {
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (!isRecord(payload)) {
      continue;
    }
    if (protocol === "anthropic") {
      const type = typeof payload["type"] === "string" ? payload["type"] : event.event;
      if (type === "message_start" && isRecord(payload["message"])) {
        merged = mergeUsage(merged, readUsageFromJson(protocol, payload["message"]));
        continue;
      }
      if (type === "message_delta" && isRecord(payload["usage"])) {
        merged = mergeUsage(merged, readAnthropicUsage(payload["usage"]));
        continue;
      }
      continue;
    }
    // OpenAI 兼容：Chat Completions 的 usage 在最后一个块里，
    // Responses API 则包在 response.completed 事件的 response.usage 下。
    const usage = readOpenAiUsageBlock(payload);
    if (usage) {
      merged = mergeUsage(merged, readOpenAiUsage(usage));
    }
  }
  return merged;
}

export interface SseUsageAccumulator {
  /** 喂入一段原始文本（可能是被切断的半个事件）。 */
  push(chunk: string): void;
  /** 当前累计用量。 */
  result(): TokenUsage;
}

/**
 * 流式用量累加器。
 *
 * SSE 事件的边界不保证与网络分片对齐，因此保留未完成尾巴，等下一段补齐再解析。
 * 这是流式计费最容易出错的地方：按分片直接解析会漏掉跨片的事件。
 */
export function createSseUsageAccumulator(protocol: GatewayProtocol): SseUsageAccumulator {
  let pending = "";
  let merged = EMPTY_USAGE;

  return {
    push(chunk) {
      pending += chunk;
      const lastBoundary = pending.lastIndexOf("\n\n");
      const complete = lastBoundary >= 0 ? pending.slice(0, lastBoundary + 2) : "";
      if (complete) {
        pending = pending.slice(lastBoundary + 2);
        merged = mergeUsage(merged, readUsageFromSseChunk(protocol, complete));
      }
    },
    result() {
      if (pending.trim()) {
        merged = mergeUsage(merged, readUsageFromSseChunk(protocol, pending));
        pending = "";
      }
      return merged;
    },
  };
}
