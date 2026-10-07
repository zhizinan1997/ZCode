import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_USAGE,
  createSseUsageAccumulator,
  readUsageFromJson,
} from "../src/domain/usageParsing.js";

test("Anthropic 非流式用量：输入输出与缓存两档", () => {
  const usage = readUsageFromJson("anthropic", {
    usage: {
      input_tokens: 120,
      output_tokens: 340,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 700,
    },
  });
  assert.deepEqual(usage, {
    inputTokens: 120,
    outputTokens: 340,
    cacheReadTokens: 5000,
    cacheWriteTokens: 700,
  });
});

test("OpenAI 兼容非流式用量：prompt/completion 与缓存命中", () => {
  const usage = readUsageFromJson("openai-compatible", {
    usage: {
      prompt_tokens: 11,
      completion_tokens: 22,
      prompt_tokens_details: { cached_tokens: 33 },
    },
  });
  assert.deepEqual(usage, {
    inputTokens: 11,
    outputTokens: 22,
    cacheReadTokens: 33,
    cacheWriteTokens: 0,
  });
});

test("缺少 usage 或字段异常时按 0 处理，不抛错", () => {
  assert.deepEqual(readUsageFromJson("anthropic", {}), EMPTY_USAGE);
  assert.deepEqual(readUsageFromJson("anthropic", null), EMPTY_USAGE);
  assert.deepEqual(readUsageFromJson("anthropic", "not-an-object"), EMPTY_USAGE);
  assert.deepEqual(
    readUsageFromJson("anthropic", { usage: { input_tokens: -5, output_tokens: "abc" } }),
    EMPTY_USAGE,
  );
});

test("Anthropic 流式：输入在 message_start、输出在 message_delta，需要合并而非覆盖", () => {
  const accumulator = createSseUsageAccumulator("anthropic");
  accumulator.push(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20}}}\n\n',
  );
  accumulator.push(
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":55}}\n\n',
  );
  assert.deepEqual(accumulator.result(), {
    inputTokens: 100,
    outputTokens: 55,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
  });
});

test("SSE 事件被网络分片切断时仍能正确解析", () => {
  const accumulator = createSseUsageAccumulator("anthropic");
  const full =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n';
  // 逐字符喂入，模拟极端分片
  for (const char of full) {
    accumulator.push(char);
  }
  assert.deepEqual(accumulator.result(), {
    inputTokens: 7,
    outputTokens: 9,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test("OpenAI 流式的 usage 只在最后一个块里", () => {
  const accumulator = createSseUsageAccumulator("openai");
  accumulator.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  accumulator.push('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n');
  accumulator.push("data: [DONE]\n\n");
  assert.deepEqual(accumulator.result(), {
    inputTokens: 3,
    outputTokens: 4,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test("多次 message_delta 取累计值而不是最后一次", () => {
  const accumulator = createSseUsageAccumulator("anthropic");
  accumulator.push('data: {"type":"message_start","message":{"usage":{"input_tokens":50}}}\n\n');
  accumulator.push('data: {"type":"message_delta","usage":{"output_tokens":10}}\n\n');
  accumulator.push('data: {"type":"message_delta","usage":{"output_tokens":25}}\n\n');
  const usage = accumulator.result();
  assert.equal(usage.inputTokens, 50);
  assert.equal(usage.outputTokens, 25);
});

test("非法 JSON 的 SSE 数据块被跳过", () => {
  const accumulator = createSseUsageAccumulator("anthropic");
  accumulator.push("data: {broken json\n\n");
  accumulator.push('data: {"type":"message_delta","usage":{"output_tokens":5}}\n\n');
  assert.equal(accumulator.result().outputTokens, 5);
});

test("OpenAI Responses 流式：response.completed 里的 response.usage 被解析（审计#2）", () => {
  const accumulator = createSseUsageAccumulator("openai");
  accumulator.push(
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
  );
  accumulator.push(
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":120,"output_tokens":34,"input_tokens_details":{"cached_tokens":50}}}}\n\n',
  );
  assert.deepEqual(accumulator.result(), {
    inputTokens: 120,
    outputTokens: 34,
    cacheReadTokens: 50,
    cacheWriteTokens: 0,
  });
});

test("OpenAI 兼容非流式：usage 包在 response 下时也能解析（审计#2）", () => {
  const usage = readUsageFromJson("openai-compatible", {
    id: "resp-1",
    response: { usage: { prompt_tokens: 7, completion_tokens: 9 } },
  });
  assert.deepEqual(usage, {
    inputTokens: 7,
    outputTokens: 9,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  // 顶层 usage 仍然优先
  const topLevel = readUsageFromJson("openai", {
    usage: { prompt_tokens: 1, completion_tokens: 2 },
    response: { usage: { prompt_tokens: 7, completion_tokens: 9 } },
  });
  assert.equal(topLevel.inputTokens, 1);
});
