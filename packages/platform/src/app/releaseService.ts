/**
 * 客户端发布与更新 manifest。
 *
 * 客户端已经实现了 manifest 的解析与校验（packages/desktop/src/main/manifestUpdateProvider.ts），
 * 服务端只需按同一份契约生成 YAML：
 *   - 顶层必须有字符串 version；
 *   - files[].url 是相对路径，客户端按 manifest 同源解析；
 *   - **每个文件必须带 sha512**，缺失时客户端会直接拒绝整个 manifest。
 *
 * YAML 手写生成，不引入 yaml 依赖：字段极少，且全部用双引号包裹，
 * 而 YAML 的双引号标量与 JSON 字符串转义规则一致，releaseNotes 里的换行也能安全承载。
 */
import { PlatformError } from "../domain/errors.js";
import type {
  ReleaseChannel,
  ReleasePlatform,
  ReleaseRecord,
} from "../domain/releases.js";
import { buildReleaseDownloadPath, pickLatestRelease } from "../domain/releases.js";
import type { ReleaseRepository } from "./ports.js";

export interface ReleaseService {
  list(): Promise<ReleaseRecord[]>;
  upsert(input: {
    version: string;
    channel: ReleaseChannel;
    platform: string;
    fileName: string;
    sha512: string;
    sizeBytes?: number | null;
    releaseNotes?: string | null;
  }): Promise<ReleaseRecord>;
  remove(releaseId: string): Promise<void>;
  /** 生成客户端要的 YAML manifest；该平台该通道没有任何发布时返回 null。 */
  buildManifest(input: {
    platform: string;
    channel: ReleaseChannel;
  }): Promise<string | null>;
  findReleaseFile(input: {
    version: string;
    fileName: string;
  }): Promise<ReleaseRecord | null>;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new PlatformError("invalid_request", `${label}不能为空`);
  }
  return trimmed;
}

function validateVersion(version: string): string {
  const trimmed = requireNonEmpty(version, "版本号");
  if (!/^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.-]+)?$/.test(trimmed)) {
    throw new PlatformError("invalid_request", "版本号格式不正确（形如 1.2.3）");
  }
  return trimmed;
}

function validateSha512(sha512: string): string {
  const trimmed = requireNonEmpty(sha512, "sha512");
  // 客户端用 electron-updater 校验，它期待的是 base64 编码的 64 字节摘要。
  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, "base64");
  } catch {
    throw new PlatformError("invalid_request", "sha512 必须是 base64 编码");
  }
  if (decoded.length !== 64) {
    throw new PlatformError(
      "invalid_request",
      "sha512 必须是 base64 编码的 64 字节摘要（用 `sha512sum <文件> | cut -d' ' -f1 | xxd -r -p | base64 -w0` 生成）",
    );
  }
  return trimmed;
}

/** 只允许安全的文件名，避免产物路径被写进其它位置。 */
function validateFileName(fileName: string): string {
  const trimmed = requireNonEmpty(fileName, "文件名");
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new PlatformError("invalid_request", "文件名不能包含路径分隔符");
  }
  return trimmed;
}

export function createReleaseService(deps: {
  readonly releases: ReleaseRepository;
  readonly now: () => number;
  readonly newReleaseId: () => string;
}): ReleaseService {
  return {
    async list() {
      return await deps.releases.list();
    },

    async upsert(input) {
      const version = validateVersion(input.version);
      const fileName = validateFileName(input.fileName);
      const sha512 = validateSha512(input.sha512);
      const platform = requireNonEmpty(input.platform, "平台标识");
      if (input.sizeBytes !== undefined && input.sizeBytes !== null) {
        if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
          throw new PlatformError("invalid_request", "文件大小必须是非负整数");
        }
      }
      const record: ReleaseRecord = {
        id: deps.newReleaseId(),
        version,
        channel: input.channel,
        platform,
        fileName,
        sha512,
        sizeBytes: input.sizeBytes ?? null,
        releaseNotes: input.releaseNotes?.trim() || null,
        createdAt: deps.now(),
      };
      await deps.releases.upsert(record);
      return record;
    },

    async remove(releaseId) {
      await deps.releases.remove(releaseId);
    },

    async buildManifest({ platform, channel }) {
      const tagged = await deps.releases.listByTag({ channel, platform });
      const latest = pickLatestRelease(tagged);
      if (!latest) {
        return null;
      }
      const lines: string[] = [
        `version: ${quote(latest.version)}`,
        `releaseName: ${quote(latest.version)}`,
        `releaseDate: ${quote(new Date(latest.createdAt).toISOString())}`,
        "files:",
        `  - url: ${quote(buildReleaseDownloadPath(latest.version, latest.fileName))}`,
        `    sha512: ${quote(latest.sha512)}`,
      ];
      if (latest.sizeBytes !== null) {
        lines.push(`    size: ${latest.sizeBytes}`);
      }
      if (latest.releaseNotes) {
        lines.push(`releaseNotes: ${quote(latest.releaseNotes)}`);
      }
      return `${lines.join("\n")}\n`;
    },

    async findReleaseFile({ version, fileName }) {
      const list = await deps.releases.list();
      return (
        list.find((item) => item.version === version && item.fileName === fileName) ?? null
      );
    },
  };
}

export type { ReleasePlatform };
