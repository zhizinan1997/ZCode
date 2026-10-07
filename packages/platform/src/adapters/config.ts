/**
 * 平台服务配置。全部来自环境变量，缺失关键项直接拒绝启动。
 *
 * 默认只监听 127.0.0.1：平台持有上游 API key 与全部用户余额，暴露到公网必须是显式决定，
 * 不能因为忘记配置就默认对外开放。容器部署时由 env 显式打开。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PlatformError } from "../domain/errors.js";

const DEFAULT_PORT = 3100;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 管理后台静态目录的默认位置：包根下的 console/。
 *
 * 从本文件位置推导而不是用 cwd：源码运行（src/adapters/）与构建产物运行（dist/adapters/）
 * 都在包根下两层，两种运行方式都能命中同一个目录。
 */
const DEFAULT_CONSOLE_DIR = fileURLToPath(new URL("../../console", import.meta.url));

export interface PlatformConfig {
  readonly dbPath: string;
  readonly host: string;
  readonly port: number;
  readonly tokenSecret: string;
  readonly sessionTtlMs: number;
  readonly logLevel: string;
  /**
   * 对外可访问的站点根地址（形如 https://your-domain.com）。
   *
   * 用来生成客户端要拉取的绝对地址（模型目录、更新产物）。部署在反向代理后面时
   * 必须显式配置：否则只能从请求头推断，而请求头是客户端可伪造的。
   */
  readonly publicOrigin: string | null;
  /** 单次模型请求的输出上限；0 表示不限制。用于限制单次预扣敞口。 */
  readonly outputTokenCap: number;
  readonly upstreamTimeoutMs: number;
  /** 管理后台静态目录。 */
  readonly consoleDir: string;
  /** 客户端安装包存放目录；manifest 里的下载地址指向它下面的文件。 */
  readonly releasesDir: string;
}

function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function readPositiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = readEnv(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PlatformError("internal_error", `${name} 必须是正整数，收到 ${raw}`);
  }
  return parsed;
}

/** 允许 0 的非负整数，用于"不限制"这类语义。 */
function readNonNegativeInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = readEnv(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PlatformError("internal_error", `${name} 必须是非负整数，收到 ${raw}`);
  }
  return parsed;
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PlatformError("internal_error", `站点地址不是合法 URL：${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new PlatformError("internal_error", `站点地址必须是 http(s)：${value}`);
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function resolvePlatformConfig(
  env: Record<string, string | undefined> = process.env,
): PlatformConfig {
  const tokenSecret = readEnv(env, "ZCODE_PLATFORM_TOKEN_SECRET");
  if (!tokenSecret) {
    throw new PlatformError(
      "internal_error",
      "缺少 ZCODE_PLATFORM_TOKEN_SECRET：平台拒绝在可被伪造令牌的情况下启动",
    );
  }
  const repositoryRoot = readEnv(env, "ZCODE_PLATFORM_DATA_DIR") ?? process.cwd();
  const publicOrigin = readEnv(env, "ZCODE_PLATFORM_PUBLIC_ORIGIN");
  return {
    dbPath: readEnv(env, "ZCODE_PLATFORM_DB_PATH") ?? join(repositoryRoot, "platform.sqlite"),
    host: readEnv(env, "ZCODE_PLATFORM_HOST") ?? DEFAULT_HOST,
    port: readPositiveInteger(env, "ZCODE_PLATFORM_PORT", DEFAULT_PORT),
    tokenSecret,
    sessionTtlMs: readPositiveInteger(env, "ZCODE_PLATFORM_SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS),
    logLevel: readEnv(env, "ZCODE_PLATFORM_LOG_LEVEL") ?? "info",
    publicOrigin: publicOrigin ? normalizeOrigin(publicOrigin) : null,
    outputTokenCap: readNonNegativeInteger(env, "ZCODE_PLATFORM_OUTPUT_TOKEN_CAP", 0),
    upstreamTimeoutMs: readPositiveInteger(
      env,
      "ZCODE_PLATFORM_UPSTREAM_TIMEOUT_MS",
      DEFAULT_UPSTREAM_TIMEOUT_MS,
    ),
    consoleDir: readEnv(env, "ZCODE_PLATFORM_CONSOLE_DIR") ?? DEFAULT_CONSOLE_DIR,
    releasesDir: readEnv(env, "ZCODE_PLATFORM_RELEASES_DIR") ?? join(repositoryRoot, "releases"),
  };
}
