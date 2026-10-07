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

interface ParsedVersion {
  /** 主版本段；非数字段按 0 处理，保持对历史数据的宽容。 */
  readonly core: number[];
  /** 预发布标识符段；无预发布段为 null。 */
  readonly prerelease: string[] | null;
}

function parseVersion(value: string): ParsedVersion {
  // 忽略前导 v 与构建元数据（+ 之后不参与优先级比较）。
  const withoutPrefix = value.trim().replace(/^v/i, "");
  const withoutBuild = withoutPrefix.split("+")[0] ?? withoutPrefix;
  const dashIndex = withoutBuild.indexOf("-");
  const coreText = dashIndex >= 0 ? withoutBuild.slice(0, dashIndex) : withoutBuild;
  const prereleaseText = dashIndex >= 0 ? withoutBuild.slice(dashIndex + 1) : "";
  const core = coreText.split(".").map((part) => {
    const numeric = Number.parseInt(part, 10);
    return Number.isFinite(numeric) ? numeric : 0;
  });
  return { core, prerelease: prereleaseText.length > 0 ? prereleaseText.split(".") : null };
}

/** 纯数字标识符按数值比较：去前导零后先比长度再比字典序，避免大数精度问题。 */
function compareNumericIdentifiers(left: string, right: string): number {
  const trimmedLeft = left.replace(/^0+/, "") || "0";
  const trimmedRight = right.replace(/^0+/, "") || "0";
  if (trimmedLeft.length !== trimmedRight.length) {
    return trimmedLeft.length > trimmedRight.length ? 1 : -1;
  }
  if (trimmedLeft === trimmedRight) {
    return 0;
  }
  return trimmedLeft > trimmedRight ? 1 : -1;
}

/** 预发布段按 semver 规则逐段比较；段数少者更低（alpha < alpha.1）。 */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const compared = compareNumericIdentifiers(leftPart, rightPart);
      if (compared !== 0) {
        return compared;
      }
      continue;
    }
    // 数字标识恒低于字母数字标识（1.0.0-2 < 1.0.0-alpha）。
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }
  return 0;
}

/**
 * 版本比较：完整 semver 优先级规则（审计#19）。
 *
 * 旧实现把 `-`/`+` 后的段当整数丢掉，导致 1.0.0-beta 与 1.0.0 判等，
 * 预发布版本可能被当成正式版发布给客户端。现在：
 * 预发布版本低于同号正式版；预发布标识按 semver 逐段比较（数字段数值比、
 * 数字低于字母数字、非数字段字典序、段数少者更低）；构建元数据不参与比较。
 */
export function compareVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  const coreLength = Math.max(parsedLeft.core.length, parsedRight.core.length);
  for (let index = 0; index < coreLength; index += 1) {
    const leftValue = parsedLeft.core[index] ?? 0;
    const rightValue = parsedRight.core[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }
  if (parsedLeft.prerelease === null && parsedRight.prerelease === null) {
    return 0;
  }
  // 有预发布段的一侧更低：1.0.0-beta < 1.0.0。
  if (parsedLeft.prerelease === null) {
    return 1;
  }
  if (parsedRight.prerelease === null) {
    return -1;
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

export function pickLatestRelease(releases: readonly ReleaseRecord[]): ReleaseRecord | null {
  if (releases.length === 0) {
    return null;
  }
  return releases.reduce((latest, candidate) =>
    compareVersions(candidate.version, latest.version) > 0 ? candidate : latest,
  );
}
