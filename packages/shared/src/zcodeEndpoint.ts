import type { ZCodeEnv } from "./env.js";

// 这里不能从 env.js 值导入 ZCODE_PRODUCT_FLAVOR：desktop 的 vite.config.ts 会在 Node 下直接
// 加载本文件，Node 的类型剥离不会把相对 "./env.js" 重写成 "./env.ts"，值导入会在模块解析阶段
// 报 ERR_MODULE_NOT_FOUND；CLI 的 esbuild 又把 "@zcode/shared" 别名到 index.ts，包自引用子路径
// 同样解析不到。因此就地按 env.ts 的同一条规则读构建期 define（缺 define 时退回 ZCODE_ENV 语义）。
declare const __ZCODE_PRODUCT_FLAVOR__: string | undefined;
declare const __ZCODE_ENV__: string | undefined;

function isProductionProductFlavor(): boolean {
  const flavor =
    typeof __ZCODE_PRODUCT_FLAVOR__ !== "undefined"
      ? __ZCODE_PRODUCT_FLAVOR__?.trim().toLowerCase()
      : undefined;
  if (flavor === "production" || flavor === "preview") {
    return flavor === "production";
  }
  const env =
    typeof __ZCODE_ENV__ !== "undefined" ? __ZCODE_ENV__?.trim().toLowerCase() : undefined;
  return env === "production";
}

/**
 * 产品默认服务地址。
 *
 * 商业版域名边界（见 specs/platform/brand-boundary.md）：商业版客户端不得私下访问第三方厂商域名，
 * 因此默认值留空。构建期必须通过 ZCODE_BASE_URL / ZCODE_ENDPOINT_ORIGIN 注入平台地址；
 * 缺失时由 resolveZCodeEndpointOrigin fail fast，不再静默回退厂商域名。
 */
export const DEFAULT_ZCODE_ENDPOINT_ORIGIN = "";

/**
 * 开发/开源 flavor 的兼容回退地址，仅在 ZCODE_PRODUCT_FLAVOR !== "production" 时使用。
 *
 * production（商业版）flavor 解析不到显式地址时直接抛错，绝不回退到该域名；
 * 该常量同时用于把历史产物里写死的厂商 origin 改写到配置的平台地址。
 */
export const LEGACY_ZCODE_ENDPOINT_ORIGIN = "https://zcode.z.ai";

export const DEFAULT_BIGMODEL_API_ORIGIN = "https://bigmodel.cn";
export const DEFAULT_ZAI_OAUTH_ORIGIN = "https://chat.z.ai";
export const DEFAULT_ZAI_BUSINESS_BASE_URL = "https://api.z.ai";

// 构建仅注入公开链接；Node 调用方仍可显式传 env，避免读取另一进程的配置。
declare const __ZCODE_ENDPOINT_ENV__: Record<string, string | undefined> | undefined;
export function pickProductEndpointEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const keys = [
    "ZCODE_BASE_URL",
    "ZCODE_ENDPOINT_ORIGIN",
    "BIGMODEL_API_BASE_URL",
    "ZAI_OAUTH_ORIGIN",
    "ZAI_BUSINESS_BASE_URL",
    "ZAI_OAUTH_CLIENT_ID",
    "ZAI_OAUTH_APP_ID",
  ];
  return Object.fromEntries(
    keys.flatMap((key) => (env[key]?.trim() ? [[key, env[key]!.trim()]] : [])),
  );
}
/**
 * 构建期注入的公开链接。
 *
 * 安装包既没有 `.env`，进程环境里也不会带 `ZCODE_BASE_URL`（安装器与快捷方式都不写该变量），
 * 平台地址只存在于这里的编译期常量。因此它不能只在默认参数里生效：调用方显式传入
 * `process.env` 时也必须能读到，否则 production 产物会在模块求值阶段抛「商业版未配置服务地址」。
 */
function readBuildInjectedEndpointEnv(): Record<string, string | undefined> {
  return typeof __ZCODE_ENDPOINT_ENV__ === "undefined" ? {} : __ZCODE_ENDPOINT_ENV__;
}
export function readProductEndpointEnv(): Record<string, string | undefined> {
  return {
    ...readBuildInjectedEndpointEnv(),
    ...pickProductEndpointEnv(typeof process === "undefined" ? {} : process.env),
  };
}

export interface ZCodeEndpointUrls {
  origin: string;
  apiBaseUrl: string;
  webShareCallbackUrl: string;
  zcodePlanOpenAiBaseUrl: string;
  zcodePlanAnthropicBaseUrl: string;
  zcodePlanBillingCurrentUrl: string;
  zcodePlanBillingBalanceUrl: string;
}

export interface RuntimeZCodeEndpointEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string;
  ZCODE_BASE_URL?: string;
  ZCODE_ENDPOINT_ORIGIN?: string;
}

export interface RuntimeBigModelApiEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string;
  BIGMODEL_API_BASE_URL?: string;
}

export interface RuntimeZaiEndpointEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string;
  ZAI_OAUTH_ORIGIN?: string;
  ZAI_BUSINESS_BASE_URL?: string;
  ZAI_OAUTH_CLIENT_ID?: string;
  ZAI_OAUTH_APP_ID?: string;
}

export interface RuntimeProductEndpointEnv
  extends RuntimeZCodeEndpointEnv, RuntimeBigModelApiEnv, RuntimeZaiEndpointEnv {}

export interface RuntimeProductEndpointConfig {
  zcodeEnv: ZCodeEnv;
  zcodeEndpointOrigin: string;
  zcodeEndpointUrls: ZCodeEndpointUrls;
  zaiOAuthOrigin: string;
  zaiBusinessBaseUrl: string;
  zaiOAuthClientId: string;
  bigModelApiOrigin: string;
}

function readRuntimeEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  if (value) {
    return value;
  }
  // 显式传入的 env 优先（覆盖构建期值），但缺失时回退到构建期注入：打包后的 production 客户端
  // 进程环境里没有 ZCODE_BASE_URL，只看传入的 env 会让它在启动期就 fail fast。
  const injected = readBuildInjectedEndpointEnv()[key]?.trim();
  return injected ? injected : undefined;
}

export function normalizeZCodeEndpointOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("ZCode endpoint origin is empty");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("ZCode endpoint origin must use http or https");
  }
  return parsed.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isTrustedCodingPlanWebviewOrigin(
  value: string | null | undefined,
  options?: {
    e2eStoreBridgeEnabled?: boolean;
  },
): boolean {
  if (!value) return false;
  try {
    const origin = normalizeZCodeEndpointOrigin(value);
    // 商业版域名边界：只信任当前配置的服务地址，不再把写死的厂商 origin 视为可信。
    if (origin === resolveRuntimeZCodeEndpointOrigin()) {
      return true;
    }
    const parsed = new URL(origin);
    return options?.e2eStoreBridgeEnabled === true && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * 解析缺省服务地址。
 *
 * 商业版（production flavor）没有显式地址时 fail fast：宁可构建/启动失败，
 * 也不能让客户端静默落到厂商域名（商业版域名边界）。
 * 开发/开源 flavor 保持既有行为，回退 LEGACY_ZCODE_ENDPOINT_ORIGIN。
 */
export function resolveDefaultZCodeEndpointOrigin(): string {
  if (isProductionProductFlavor()) {
    throw new Error(
      "商业版未配置服务地址：构建期必须注入 ZCODE_BASE_URL 或 ZCODE_ENDPOINT_ORIGIN，拒绝回退厂商域名。",
    );
  }
  return LEGACY_ZCODE_ENDPOINT_ORIGIN;
}

export function resolveZCodeEndpointOrigin(options?: {
  env?: ZCodeEnv;
  envBaseOrigin?: string | null;
  overrideOrigin?: string | null;
}): string {
  const origin = options?.overrideOrigin?.trim() || options?.envBaseOrigin?.trim();
  return origin ? normalizeZCodeEndpointOrigin(origin) : resolveDefaultZCodeEndpointOrigin();
}

export function resolveRuntimeZCodeEnv(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
): ZCodeEnv {
  // 产品身份仅用于既有展示与安装标识，不参与地址解析。
  return env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production";
}

export function resolveRuntimeZCodeEndpointOrigin(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
  options?: { overrideOrigin?: string | null },
): string {
  return resolveZCodeEndpointOrigin({
    envBaseOrigin:
      readRuntimeEnvValue(env, "ZCODE_BASE_URL") ??
      readRuntimeEnvValue(env, "ZCODE_ENDPOINT_ORIGIN"),
    overrideOrigin: options?.overrideOrigin,
  });
}

export function buildRuntimeZCodeEndpointUrls(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
): ZCodeEndpointUrls {
  return buildZCodeEndpointUrls(resolveRuntimeZCodeEndpointOrigin(env));
}

export function buildRuntimeZCodeApiUrl(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveRuntimeZCodeEndpointOrigin(env)}${normalizedPath}`;
}

/**
 * 官方插件资源与市场目录的基地址。
 *
 * 跟随客户端配置的服务地址，而不再固定指向厂商 CDN：商业部署下客户端不应该
 * 私下访问你不控制的第三方域名（既不可控，也可能随时下线）。平台若没有托管
 * 这些路径，插件商店会呈现为空，而不是悄悄去厂商 CDN 取内容。
 */
export function resolveOfficialPluginBaseUrl(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
): string {
  return `${resolveRuntimeZCodeEndpointOrigin(env)}/zcode/official-plugin`;
}

export function resolveBigModelApiOrigin(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "BIGMODEL_API_BASE_URL") ?? DEFAULT_BIGMODEL_API_ORIGIN,
  );
}

export function buildBigModelApiUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveBigModelApiOrigin(env)}${normalizedPath}`;
}

export function buildBigModelCodingPlanPersonalManageUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  // 管理页与业务 API 共用显式 origin，避免把已登录账号带到另一个部署。
  return buildBigModelApiUrl(env, "/coding-plan/personal/overview");
}

export function buildBigModelCodingPlanTeamManageUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  return buildBigModelApiUrl(env, "/coding-plan/team/plans");
}

export function resolveZaiOAuthOrigin(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_OAUTH_ORIGIN") ?? DEFAULT_ZAI_OAUTH_ORIGIN,
  );
}

export function resolveZaiBusinessBaseUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_BUSINESS_BASE_URL") ?? DEFAULT_ZAI_BUSINESS_BASE_URL,
  );
}

export function resolveZaiOAuthClientId(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  // 商业版域名边界：不再内置厂商 OAuth client id，只接受运行时/构建期显式注入。
  return (
    readRuntimeEnvValue(env, "ZAI_OAUTH_CLIENT_ID") ??
    readRuntimeEnvValue(env, "ZAI_OAUTH_APP_ID") ??
    ""
  );
}

export function buildZaiOAuthUrl(origin: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeZCodeEndpointOrigin(origin)}${normalizedPath}`;
}

export function buildRuntimeZaiOAuthUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  return buildZaiOAuthUrl(resolveZaiOAuthOrigin(env), path);
}

export function buildRuntimeZaiBusinessUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveZaiBusinessBaseUrl(env)}${normalizedPath}`;
}

export function resolveRuntimeProductEndpointConfig(
  env: RuntimeProductEndpointEnv = readProductEndpointEnv(),
): RuntimeProductEndpointConfig {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(env);

  return {
    zcodeEnv,
    zcodeEndpointOrigin,
    zcodeEndpointUrls: buildZCodeEndpointUrls(zcodeEndpointOrigin),
    zaiOAuthOrigin: resolveZaiOAuthOrigin(env),
    zaiBusinessBaseUrl: resolveZaiBusinessBaseUrl(env),
    zaiOAuthClientId: resolveZaiOAuthClientId(env),
    bigModelApiOrigin: resolveBigModelApiOrigin(env),
  };
}

export function buildZCodeEndpointUrls(origin: string): ZCodeEndpointUrls {
  const normalizedOrigin = normalizeZCodeEndpointOrigin(origin);
  return {
    origin: normalizedOrigin,
    apiBaseUrl: `${normalizedOrigin}/api/v1`,
    webShareCallbackUrl: `${normalizedOrigin}/cn/share/callback`,
    zcodePlanOpenAiBaseUrl: `${normalizedOrigin}/api/v1/zcode-plan`,
    zcodePlanAnthropicBaseUrl: `${normalizedOrigin}/api/v1/zcode-plan/anthropic`,
    zcodePlanBillingCurrentUrl: `${normalizedOrigin}/api/v1/zcode-plan/billing/current`,
    zcodePlanBillingBalanceUrl: `${normalizedOrigin}/api/v1/zcode-plan/billing/balance`,
  };
}

export function rewriteZCodeEndpointUrl(input: string | URL, endpointOrigin: string): string | URL {
  const originalUrl = typeof input === "string" ? input : input.toString();
  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return input;
  }
  // 历史产物与旧配置里可能写死了厂商 origin；这类 URL 仍要改写到配置的平台地址，
  // 避免客户端把请求发到第三方厂商域名（商业版域名边界）。
  const sourceOrigin = LEGACY_ZCODE_ENDPOINT_ORIGIN;
  if (parsed.origin !== sourceOrigin) {
    return input;
  }

  const targetOrigin = normalizeZCodeEndpointOrigin(endpointOrigin);
  if (targetOrigin === sourceOrigin) {
    return input;
  }

  const target = new URL(targetOrigin);
  target.pathname = parsed.pathname;
  target.search = parsed.search;
  target.hash = parsed.hash;
  return target.toString();
}
