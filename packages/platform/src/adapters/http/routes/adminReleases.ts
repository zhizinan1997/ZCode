/**
 * 管理接口：客户端发布；以及面向客户端的产物下载。
 *
 * 上传用原始二进制 PUT（不是 multipart）：管理页面把 File 直接作为 body 发过来，
 * 服务端边写盘边算 sha512 与大小，省掉手写 multipart 解析，也不会把大文件读进内存。
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Hono } from "hono";
import { createWriteStream } from "node:fs";
import type { AccountService } from "../../../app/accountService.js";
import type { ReleaseService } from "../../../app/releaseService.js";
import { PlatformError } from "../../../domain/errors.js";
import { RELEASE_CHANNELS, type ReleaseChannel } from "../../../domain/releases.js";
import { createAdminGuard } from "./adminSupport.js";

/** 版本号与文件名会拼进磁盘路径，必须在边界上挡住路径穿越。 */
const SAFE_SEGMENT = /^[0-9A-Za-z._-]+$/;

function requireSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || !SAFE_SEGMENT.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new PlatformError("invalid_request", `${label}只允许字母、数字、点、下划线与连字符`);
  }
  return trimmed;
}

/**
 * 审计#17：下载侧的名称校验。
 * 版本/文件名不允许路径分隔符与 `.`/`..`（目录遍历），不合法一律按"不存在"处理，
 * 不给探测者语法反馈。
 */
function readDownloadSegment(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !SAFE_SEGMENT.test(trimmed) || trimmed === "." || trimmed === "..") {
    return null;
  }
  return trimmed;
}

/**
 * 审计#18：Windows 上 rename 覆盖已存在目标会失败（EPERM/EACCES/EEXIST）。
 * 目标已被登记为可替换的旧产物，因此先删旧再改名；允许极短的"目标缺失"窗口，
 * 但绝不会出现半写入的最终文件。
 */
async function replaceFileAtomically(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES" && code !== "ENOTEMPTY") {
      throw error;
    }
  }
  await rm(target, { force: true });
  await rename(source, target);
}

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 审计#17：解析单段 Range。返回 null 表示按完整内容响应（无 Range 或按 RFC 7233 忽略
 * 的多段 Range），返回 "invalid" 表示不可满足，调用方回 416。
 */
function parseRangeHeader(header: string | undefined, size: number): ByteRange | null | "invalid" {
  if (header === undefined) {
    return null;
  }
  const trimmed = header.trim();
  const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!match) {
    // 非 bytes 单位与多段 Range 按 RFC 7233 允许的方式忽略，返回完整内容。
    return /^bytes=/i.test(trimmed) && !trimmed.includes(",") ? "invalid" : null;
  }
  const [, startText, endText] = match;
  if (startText === "" && endText === "") {
    return "invalid";
  }
  if (size === 0) {
    return "invalid";
  }
  if (startText === "") {
    // 后缀范围 bytes=-N：取最后 N 字节；N=0 不可满足，N 超过文件大小取整个文件。
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return "invalid";
    }
    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start >= size) {
    return "invalid";
  }
  if (endText === "") {
    return { start, end: size - 1 };
  }
  const requestedEnd = Number(endText);
  if (!Number.isSafeInteger(requestedEnd)) {
    return "invalid";
  }
  const end = Math.min(requestedEnd, size - 1);
  if (end < start) {
    return "invalid";
  }
  return { start, end };
}

function readChannel(value: string | undefined): ReleaseChannel {
  const trimmed = value?.trim();
  return (RELEASE_CHANNELS as readonly string[]).includes(trimmed ?? "")
    ? (trimmed as ReleaseChannel)
    : "stable";
}

export function createAdminReleaseRoutes(deps: {
  readonly accounts: AccountService;
  readonly releases: ReleaseService;
  readonly releasesDir: string;
}): Hono {
  const routes = new Hono();
  const requireAdmin = createAdminGuard(deps.accounts);

  routes.get("/releases", async (context) => {
    await requireAdmin(context);
    const releases = await deps.releases.list();
    return context.json({
      releases: releases.map((release) => ({
        ...release,
        downloadPath: `/releases/electron/${release.version}/${release.fileName}`,
      })),
    });
  });

  routes.put("/releases/:version/:fileName", async (context) => {
    await requireAdmin(context);
    const version = requireSegment(context.req.param("version"), "版本号");
    const fileName = requireSegment(context.req.param("fileName"), "文件名");
    const channel = readChannel(context.req.query("channel"));
    const platform = requireSegment(context.req.query("platform") ?? "", "平台标识");
    const releaseNotes = context.req.query("releaseNotes")?.trim() || null;

    const body = context.req.raw.body;
    if (!body) {
      throw new PlatformError("invalid_request", "请求体为空，未收到安装包内容");
    }

    const directory = join(deps.releasesDir, version);
    await mkdir(directory, { recursive: true });
    const targetPath = join(directory, fileName);

    // 审计#18：先写同目录临时文件，完整写入并校验后再 rename 到最终名。
    // 这样下载侧永远看不到半截文件，上传中断也只会留下可清理的临时文件。
    const tempPath = join(directory, `.tmp-${fileName}-${randomBytes(6).toString("hex")}`);
    const hash = createHash("sha512");
    let size = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(body as never), meter, createWriteStream(tempPath));
      if (size === 0) {
        throw new PlatformError("invalid_request", "上传内容为空");
      }
      // 校验实际落盘大小与写入计数一致，防止短写后把坏文件 rename 成正式产物。
      const written = await stat(tempPath);
      if (!written.isFile() || written.size !== size) {
        throw new PlatformError("internal_error", "上传内容不完整，已取消本次上传");
      }
      await replaceFileAtomically(tempPath, targetPath);
    } catch (error) {
      // 失败清理临时文件；rename 成功前旧文件不受影响，因此不会留下半文件。
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }

    const record = await deps.releases.upsert({
      version,
      channel,
      platform,
      fileName,
      sha512: hash.digest("base64"),
      sizeBytes: size,
      releaseNotes,
    });
    return context.json({ release: record }, 201);
  });

  routes.delete("/releases/:id", async (context) => {
    await requireAdmin(context);
    await deps.releases.remove(context.req.param("id"));
    return context.body(null, 204);
  });

  return routes;
}

/**
 * 产物下载（公开）。
 *
 * 安装包本身就是要发给用户的，因此不做鉴权；但仍要挡住路径穿越
 * （审计#17），并且只有登记在发布记录里的文件才能被下载——磁盘上碰巧存在的
 * 文件不对外提供。支持单段 Range（更新器断点续传/分段下载）。
 */
export function createReleaseDownloadRoutes(deps: {
  readonly releasesDir: string;
  readonly releases: ReleaseService;
}): Hono {
  const routes = new Hono();

  routes.get("/releases/electron/:version/:fileName", async (context) => {
    const version = readDownloadSegment(context.req.param("version"));
    const fileName = readDownloadSegment(context.req.param("fileName"));
    if (!version || !fileName) {
      throw new PlatformError("not_found", "产物不存在");
    }
    // 审计#17：未登记的产物一律 404，不能只凭路径判存在。
    if (!(await deps.releases.findReleaseFile({ version, fileName }))) {
      throw new PlatformError("not_found", "产物不存在");
    }

    const targetPath = join(deps.releasesDir, version, fileName);
    let fileStat;
    try {
      fileStat = await stat(targetPath);
    } catch {
      throw new PlatformError("not_found", "产物不存在");
    }
    if (!fileStat.isFile()) {
      throw new PlatformError("not_found", "产物不存在");
    }

    // 审计#17：Range 支持。非法/不可满足回 416，其余回 206，未带 Range 回 200。
    const range = parseRangeHeader(context.req.header("range"), fileStat.size);
    if (range === "invalid") {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${fileStat.size}`, "accept-ranges": "bytes" },
      });
    }

    const headers = {
      "content-type": "application/octet-stream",
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=86400",
    };
    if (range === null) {
      const stream = Readable.toWeb(createReadStream(targetPath)) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        status: 200,
        headers: { ...headers, "content-length": String(fileStat.size) },
      });
    }
    const stream = Readable.toWeb(
      createReadStream(targetPath, { start: range.start, end: range.end }),
    ) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${range.start}-${range.end}/${fileStat.size}`,
        "content-length": String(range.end - range.start + 1),
      },
    });
  });

  return routes;
}
