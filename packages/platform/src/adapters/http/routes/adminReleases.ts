/**
 * 管理接口：客户端发布；以及面向客户端的产物下载。
 *
 * 上传用原始二进制 PUT（不是 multipart）：管理页面把 File 直接作为 body 发过来，
 * 服务端边写盘边算 sha512 与大小，省掉手写 multipart 解析，也不会把大文件读进内存。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
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

    const hash = createHash("sha512");
    let size = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(body as never), meter, createWriteStream(targetPath));
    if (size === 0) {
      throw new PlatformError("invalid_request", "上传内容为空");
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
 * 安装包本身就是要发给用户的，因此不做鉴权；但仍要挡住路径穿越，
 * 否则任何人都能通过构造路径读到服务器上的任意文件。
 */
export function createReleaseDownloadRoutes(deps: {
  readonly releasesDir: string;
}): Hono {
  const routes = new Hono();

  routes.get("/releases/electron/:version/:fileName", async (context) => {
    const version = requireSegment(context.req.param("version"), "版本号");
    const fileName = requireSegment(context.req.param("fileName"), "文件名");
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

    const stream = Readable.toWeb(createReadStream(targetPath)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(fileStat.size),
        "cache-control": "public, max-age=86400",
      },
    });
  });

  return routes;
}
