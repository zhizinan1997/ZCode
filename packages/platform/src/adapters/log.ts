/**
 * 平台服务日志。
 *
 * 平台是独立服务进程，不属于 AGENTS.md 里"UI 用 logger.ts / agent 服务用 createServiceLogger"
 * 的两类场景，因此这里自带一个极小的结构化日志：单行 JSON，便于采集与检索。
 * 级别语义与仓库约定一致：debug 高频诊断、info 生命周期、warn 可恢复、error 不可恢复。
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function resolveThreshold(level: string | undefined): number {
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    return LEVEL_ORDER[level];
  }
  return LEVEL_ORDER.info;
}

/** 不落盘到业务日志的字段；避免把令牌与密码写进日志。 */
const REDACTED_FIELDS = new Set(["token", "password", "currentPassword", "newPassword", "secret"]);

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    output[key] = REDACTED_FIELDS.has(key) ? "[redacted]" : value;
  }
  return output;
}

export function createLogger(options: {
  scope: string;
  level?: string;
  write?: (line: string) => void;
}): Logger {
  const threshold = resolveThreshold(options.level);
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  const build = (base: Record<string, unknown>): Logger => {
    const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
      if (LEVEL_ORDER[level] < threshold) {
        return;
      }
      write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level,
          scope: options.scope,
          message,
          ...redact(base),
          ...(fields ? redact(fields) : {}),
        }),
      );
    };
    return {
      debug: (message, fields) => emit("debug", message, fields),
      info: (message, fields) => emit("info", message, fields),
      warn: (message, fields) => emit("warn", message, fields),
      error: (message, fields) => emit("error", message, fields),
      child: (fields) => build({ ...base, ...fields }),
    };
  };

  return build({});
}
