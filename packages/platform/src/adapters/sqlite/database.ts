/**
 * 平台数据库打开与迁移入口。
 *
 * 用 createRequire 取 node:sqlite，与 tasks-index 保持一致：避免将来被打包器
 * 改写成并不存在的 npm sqlite 包。
 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { runPlatformMigrations } from "./migrations.js";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** 内存库标识；测试与快速验证用它，不落盘。 */
export const IN_MEMORY_DATABASE_PATH = ":memory:";

export interface OpenPlatformDatabaseOptions {
  readonly path: string;
  /** 当前时间（epoch 毫秒），用于迁移台账。 */
  readonly now?: () => number;
}

export interface PlatformDatabase {
  readonly db: DatabaseSync;
  /** 本次启动实际执行的迁移；为空表示库已是最新。 */
  readonly appliedMigrations: readonly string[];
  close(): void;
}

export async function openPlatformDatabase(
  options: OpenPlatformDatabaseOptions,
): Promise<PlatformDatabase> {
  const now = options.now ?? (() => Date.now());
  const isMemory = options.path === IN_MEMORY_DATABASE_PATH;
  if (!isMemory) {
    await mkdir(dirname(options.path), { recursive: true });
  }

  const db = new sqlite.DatabaseSync(options.path);
  try {
    // 平台库可能被管理后台与网关进程同时打开，必须等锁而不是直接失败。
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    if (!isMemory) {
      db.exec("PRAGMA journal_mode = WAL");
    }
    const appliedMigrations = runPlatformMigrations(db, now);
    return {
      db,
      appliedMigrations,
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
