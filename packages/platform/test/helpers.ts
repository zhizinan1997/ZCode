/** 测试共用装配：内存库 + 静默日志，避免测试互相污染磁盘状态。 */
import { fileURLToPath } from "node:url";
import type { PlatformConfig } from "../src/adapters/config.js";
import { createPlatformRuntime, type PlatformRuntime } from "../src/adapters/composition.js";
import { createLogger } from "../src/adapters/log.js";
import { IN_MEMORY_DATABASE_PATH } from "../src/adapters/sqlite/database.js";
import type { UpstreamTransport } from "../src/app/ports.js";

export const TEST_TOKEN_SECRET = "test-secret-do-not-use-in-production";

/** 真实的 console 目录：静态资源测试要用它，而不是靠 cwd 猜路径。 */
export const TEST_CONSOLE_DIR = fileURLToPath(new URL("../console", import.meta.url));

export function testConfig(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    dbPath: IN_MEMORY_DATABASE_PATH,
    host: "127.0.0.1",
    port: 0,
    tokenSecret: TEST_TOKEN_SECRET,
    sessionTtlMs: 60 * 60 * 1000,
    logLevel: "error",
    publicOrigin: "https://platform.test",
    outputTokenCap: 0,
    upstreamTimeoutMs: 5_000,
    consoleDir: TEST_CONSOLE_DIR,
    releasesDir: "/nonexistent-releases",
    ...overrides,
  };
}

export async function createTestRuntime(
  overrides: Partial<PlatformConfig> = {},
  options: { upstreamTransport?: UpstreamTransport } = {},
): Promise<PlatformRuntime> {
  return await createPlatformRuntime({
    config: testConfig(overrides),
    logger: createLogger({ scope: "test", level: "error", write: () => {} }),
    ...(options.upstreamTransport ? { upstreamTransport: options.upstreamTransport } : {}),
  });
}
