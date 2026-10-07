/**
 * 管理后台静态资源。
 *
 * 后台页面是纯静态 HTML（无构建步骤），从 consoleDir 读盘提供：
 * 这样同一个目录既能在源码运行时直接生效，也能被整目录复制进容器镜像。
 */
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Hono } from "hono";
import { PlatformError } from "../../domain/errors.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * 审计#12：管理后台页面原本没有任何安全响应头。
 *
 * CSP 从 `default-src 'self'` 起步并保持严格不放宽：已核对 console 源码，
 * index.html 只有一条外部 module script（/console/app.js）与一条外部样式表，
 * 没有内联 <script>/<style>/style= 属性，各 screens-*.js 也没有 eval/new Function，
 * 页面不引用任何外链资源，因此不需要 unsafe-inline；img-src 保留 data: 与页面
 * 自带 meta CSP 一致。frame-ancestors/X-Frame-Options 一并挡住点击劫持。
 */
const CONSOLE_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** 只允许读取 consoleDir 内的文件：路径逃逸会让静态服务变成任意文件读取。 */
function resolveWithin(root: string, relativePath: string): string | null {
  const normalized = normalize(relativePath).replace(/^([/\\])+/, "");
  if (normalized.split(/[/\\]/).includes("..")) {
    return null;
  }
  const target = join(root, normalized);
  const normalizedRoot = normalize(root).endsWith(sep)
    ? normalize(root)
    : `${normalize(root)}${sep}`;
  return normalize(target).startsWith(normalizedRoot) ? target : null;
}

export function createConsoleRoutes(options: { readonly consoleDir: string }): Hono {
  const routes = new Hono();

  const serve = async (relativePath: string) => {
    const target = resolveWithin(options.consoleDir, relativePath);
    if (!target) {
      throw new PlatformError("not_found", "资源不存在");
    }
    let content: Buffer;
    try {
      content = await readFile(target);
    } catch {
      throw new PlatformError(
        "not_found",
        `管理后台资源缺失（${relativePath}）：请确认 consoleDir 指向正确，容器部署时需把 console 目录复制进镜像`,
      );
    }
    const contentType = CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    return new Response(content, {
      status: 200,
      headers: { "content-type": contentType, ...CONSOLE_SECURITY_HEADERS },
    });
  };

  routes.get("/", async () => await serve("index.html"));
  routes.get("/console/*", async (context) => {
    const prefix = "/console/";
    const rest = context.req.path.startsWith(prefix)
      ? context.req.path.slice(prefix.length)
      : context.req.path;
    return await serve(rest || "index.html");
  });

  return routes;
}
