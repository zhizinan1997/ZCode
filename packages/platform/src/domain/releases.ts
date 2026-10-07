/**
 * 客户端发布领域类型与查询参数解析（纯逻辑）。
 *
 * 客户端请求的取值形状是既有契约，必须原样遵守：
 *   GET /api/v1/releases/electron/manifest?platform=<platform>-<arch>&channel=<1|3>
 *   platform 形如 windows-x86_64 / darwin-aarch64；channel 1=stable、3=preview。
 * 这里只做归一化，不改变客户端的解析逻辑。
 */

export const RELEASE_CHANNELS = ["stable", "preview"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export const RELEASE_PLATFORMS = [
  "windows-x86_64",
  "windows-aarch64",
  "windows-x86",
  "darwin-x86_64",
  "darwin-aarch64",
  "linux-x86_64",
  "linux-aarch64",
] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

export interface ReleaseRecord {
  readonly id: string;
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly platform: string;
  readonly fileName: string;
  readonly sha512: string;
  readonly sizeBytes: number | null;
  readonly releaseNotes: string | null;
  readonly createdAt: number;
}

export function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return typeof value === "string" && (RELEASE_CHANNELS as readonly string[]).includes(value);
}

export function isReleasePlatform(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 把客户端的 channel 查询值归一化。
 * 未知值按 stable 处理：客户端在通道切换时可能发出过期请求，宁可给稳定版。
 */
export function resolveReleaseChannelFromQuery(value: string | undefined): ReleaseChannel {
  return value?.trim() === "3" ? "preview" : "stable";
}

export function resolveChannelQueryValue(channel: ReleaseChannel): string {
  return channel === "preview" ? "3" : "1";
}

/** 产物下载路径。客户端用 `new URL(url, manifestUrl)` 解析相对地址。 */
export function buildReleaseDownloadPath(version: string, fileName: string): string {
  return `/releases/electron/${encodeURIComponent(version)}/${encodeURIComponent(fileName)}`;
}

/**
 * 版本比较：只做"谁更新"的判定，不追求完整 semver 语义。
 * 主版本段按数值比较，其余按字符串补零，足以覆盖客户端 semver.gt 的场景。
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map((part) => {
        const numeric = Number.parseInt(part, 10);
        return Number.isFinite(numeric) ? numeric : 0;
      });
  const leftParts = parse(left);
  const rightParts = parse(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }
  return 0;
}

export function pickLatestRelease(
  releases: readonly ReleaseRecord[],
): ReleaseRecord | null {
  if (releases.length === 0) {
    return null;
  }
  return releases.reduce((latest, candidate) =>
    compareVersions(candidate.version, latest.version) > 0 ? candidate : latest,
  );
}
