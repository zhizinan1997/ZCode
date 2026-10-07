/**
 * 平台服务进程入口。
 *
 * 用法：
 *   node dist/adapters/entry.js                      启动 HTTP 服务
 *   node dist/adapters/entry.js create-admin <邮箱> <密码>  引导首个管理员
 *
 * 之所以需要 create-admin：账号一律由管理员创建，不存在自助注册，
 * 因此第一个管理员只能由运维在服务器上显式创建。
 */
import { serve } from "@hono/node-server";
import { createPlatformRuntime } from "./composition.js";
import { resolvePlatformConfig } from "./config.js";
import { createPlatformApp } from "./http/app.js";
import { PlatformError, toPlatformError } from "../domain/errors.js";

function printUsage(): void {
  process.stdout.write(
    [
      "ZCode 平台服务",
      "",
      "  entry.js                        启动 HTTP 服务",
      "  entry.js create-admin <邮箱> <密码>  创建管理员账号",
      "",
      "环境变量：",
      "  ZCODE_PLATFORM_TOKEN_SECRET     令牌签名密钥（必填）",
      "  ZCODE_PLATFORM_PUBLIC_ORIGIN    对外站点地址，如 https://your-domain.com（反向代理后必填）",
      "  ZCODE_PLATFORM_DB_PATH          数据库路径，默认 <数据目录>/platform.sqlite",
      "  ZCODE_PLATFORM_DATA_DIR         数据目录，默认当前工作目录",
      "  ZCODE_PLATFORM_HOST             监听地址，默认 127.0.0.1",
      "  ZCODE_PLATFORM_PORT             监听端口，默认 3100",
      "  ZCODE_PLATFORM_SESSION_TTL_MS   会话有效期，默认 30 天",
      "  ZCODE_PLATFORM_OUTPUT_TOKEN_CAP 单次请求输出上限，默认 32768，0 表示不限制",
      "  ZCODE_PLATFORM_UPSTREAM_IDLE_TIMEOUT_MS 上游无数据超时，默认 60 秒（收到分片即重置）",
      "  ZCODE_PLATFORM_CONSOLE_DIR      管理后台静态目录，默认内置 console/",
      "  ZCODE_PLATFORM_RELEASES_DIR     客户端产物目录，默认 <数据目录>/releases",
      "  ZCODE_PLATFORM_LOG_LEVEL        debug | info | warn | error，默认 info",
      "",
    ].join("\n"),
  );
}

async function runCreateAdmin(email: string, password: string): Promise<void> {
  const config = resolvePlatformConfig();
  const runtime = await createPlatformRuntime({ config });
  try {
    if (await runtime.accounts.hasAdmin()) {
      runtime.logger.warn("已存在管理员账号，未创建新账号；如需新增管理员请在管理后台创建");
      return;
    }
    const created = await runtime.accounts.createUser({ email, password, role: "admin" });
    runtime.logger.info("管理员账号已创建", { email: created.email, userId: created.id });
  } finally {
    runtime.dispose();
  }
}

async function runServer(): Promise<void> {
  const config = resolvePlatformConfig();
  const runtime = await createPlatformRuntime({ config });

  // 启动时释放因上次进程崩溃而滞留在 reserved 的预扣：
  // 不释放会让用户余额被永久占用，且他自己无法解除。
  try {
    const released = await runtime.gateway.recoverStaleReservations();
    if (released > 0) {
      runtime.logger.warn("释放了滞留的预扣记录", { released });
    }
  } catch (error) {
    runtime.logger.warn("释放滞留预扣失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const app = createPlatformApp({
    config,
    logger: runtime.logger,
    accounts: runtime.accounts,
    billing: runtime.billing,
    catalog: runtime.catalog,
    plans: runtime.plans,
    releases: runtime.releases,
    operations: runtime.operations,
    modelPublish: runtime.modelPublish,
    gateway: runtime.gateway,
    providers: runtime.repositories.providers,
    prices: runtime.repositories.prices,
    usage: runtime.repositories.usage,
    now: () => Date.now(),
    newProviderId: runtime.newProviderId,
  });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    runtime.logger.info("平台服务已启动", {
      host: info.address,
      port: info.port,
      dbPath: config.dbPath,
      publicOrigin: config.publicOrigin,
      consoleDir: config.consoleDir,
    });
  });

  const shutdown = (signal: string) => {
    runtime.logger.info("收到退出信号，正在关闭", { signal });
    server.close(() => {
      runtime.dispose();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (command === undefined) {
    await runServer();
    return;
  }
  if (command === "create-admin") {
    const [email, password] = rest;
    if (!email || !password) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    await runCreateAdmin(email, password);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  printUsage();
  process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const platformError: PlatformError = toPlatformError(error);
  process.stderr.write(
    `[platform] 启动失败 (${platformError.code}): ${platformError.message}\n` +
      (platformError.cause instanceof Error ? `${platformError.cause.stack ?? ""}\n` : ""),
  );
  process.exitCode = 1;
});
