/**
 * 上游无数据超时（审计#14）：等待响应头与等待 body 分片共用同一个计时器，收到分片即重置。
 * 用本机 http server 驱动真实 fetch，避免依赖外网。
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { createFetchUpstreamTransport } from "../src/adapters/http/upstreamTransport.js";

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, origin: `http://127.0.0.1:${port}` };
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function request(
  origin: string,
): Parameters<ReturnType<typeof createFetchUpstreamTransport>["forward"]>[0] {
  return { url: `${origin}/v1/messages`, method: "POST", headers: {}, body: "{}" };
}

test("等待响应头超过 idle 超时：forward 直接失败并带上原因（审计#14）", async () => {
  // 服务器收到请求但永不响应，模拟上游挂住
  const { server, origin } = await startServer(() => {});
  try {
    const transport = createFetchUpstreamTransport({ idleTimeoutMs: 50 });
    await assert.rejects(transport.forward(request(origin)), /没有返回数据/);
  } finally {
    await stopServer(server);
  }
});

test("响应头已返回但 body 长时间没有数据：读取以错误结束（审计#14）", async () => {
  const { server, origin } = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("hello");
    // 之后不再写数据也不结束：没有分片流动，应触发 idle abort
  });
  try {
    const transport = createFetchUpstreamTransport({ idleTimeoutMs: 60 });
    const response = await transport.forward(request(origin));
    assert.equal(response.status, 200);
    await assert.rejects(response.text(), /没有返回数据/);
  } finally {
    await stopServer(server);
  }
});

test("分片间隔小于 idle 超时时，总时长超过超时也不会被掐断（计时器按分片重置）", async () => {
  const { server, origin } = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      if (sent <= 4) {
        response.write(`chunk-${sent}`);
        return;
      }
      clearInterval(timer);
      response.end();
    }, 30);
  });
  try {
    // idle 60ms 小于总时长（约 150ms）：按总时长限制会失败，按无数据超时能完整读完。
    const transport = createFetchUpstreamTransport({ idleTimeoutMs: 60 });
    const response = await transport.forward(request(origin));
    assert.equal(await response.text(), "chunk-1chunk-2chunk-3chunk-4");
  } finally {
    await stopServer(server);
  }
});
