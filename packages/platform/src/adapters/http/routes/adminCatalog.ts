/**
 * 管理接口：模型目录、上游 provider 与模型单价。
 *
 * provider 的 API key 只写不读：GET 一律只返回末四位提示，避免管理员页面、
 * 浏览器缓存或日志成为上游密钥的泄露面。
 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { CatalogService } from "../../../app/catalogService.js";
import { PlatformError } from "../../../domain/errors.js";
import { GATEWAY_PROTOCOLS, type GatewayProtocol } from "../../../domain/gateway.js";
import { formatMicros, microsFromDecimalString, type Micros } from "../../../domain/money.js";
import type { GatewayProviderRepository, ModelPriceRepository } from "../../../app/ports.js";
import { readJsonObject, readString } from "../helpers.js";
import { createAdminGuard, type AdminResolver } from "./adminSupport.js";

function keyHint(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 4) {
    return "…";
  }
  return `…${trimmed.slice(-4)}`;
}

function parsePriceMicros(raw: string, label: string): Micros {
  try {
    return microsFromDecimalString(raw);
  } catch (error) {
    throw new PlatformError(
      "invalid_request",
      `${label}格式不正确（每百万 token 的非负十进制金额）：${raw}`,
      { cause: error },
    );
  }
}

export function createAdminCatalogRoutes(deps: {
  readonly accounts: AccountService;
  readonly catalog: CatalogService;
  readonly providers: GatewayProviderRepository;
  readonly prices: ModelPriceRepository;
  readonly now: () => number;
  readonly newProviderId: () => string;
}): Hono {
  const routes = new Hono();
  const requireAdmin: AdminResolver = createAdminGuard(deps.accounts);

  // ── 模型目录 ──────────────────────────────────────────────
  routes.get("/catalog", async (context) => {
    await requireAdmin(context);
    const current = await deps.catalog.readCurrent();
    if (!current) {
      return context.json({ revision: null, content: null, summary: null });
    }
    return context.json({
      revision: current.revision,
      content: current.content,
      summary: deps.catalog.summarize(current.content),
    });
  });

  routes.put("/catalog", async (context) => {
    const admin = await requireAdmin(context);
    const body = await readJsonObject(context);
    const content = readString(body, "content", { required: true, label: "目录内容" });
    const expectedRevision =
      typeof body["expectedRevision"] === "number" ? (body["expectedRevision"] as number) : null;
    const revision = await deps.catalog.update({
      content,
      expectedRevision,
      updatedBy: admin.user.id,
    });
    return context.json({ revision, summary: deps.catalog.summarize(content) });
  });

  // ── 上游 provider ─────────────────────────────────────────
  routes.get("/providers", async (context) => {
    await requireAdmin(context);
    const providers = await deps.providers.list();
    return context.json({
      providers: providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        upstreamBaseUrl: provider.upstreamBaseUrl,
        protocol: provider.protocol,
        enabled: provider.enabled,
        apiKeyHint: keyHint(provider.apiKey),
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt,
      })),
    });
  });

  routes.put("/providers/:id", async (context) => {
    await requireAdmin(context);
    const id = context.req.param("id").trim();
    if (!id) {
      throw new PlatformError("invalid_request", "provider id 不能为空");
    }
    const body = await readJsonObject(context);
    const existing = await deps.providers.findById(id);
    const protocolRaw = readString(body, "protocol", { required: !existing, maxLength: 40 });
    if (protocolRaw && !(GATEWAY_PROTOCOLS as readonly string[]).includes(protocolRaw)) {
      throw new PlatformError(
        "invalid_request",
        `protocol 取值非法，允许：${GATEWAY_PROTOCOLS.join(", ")}`,
      );
    }
    const protocol: GatewayProtocol = (protocolRaw || existing?.protocol || "anthropic") as GatewayProtocol;

    // apiKey 只在显式提供时更新：管理页面回显的是掩码，若原样提交会覆盖成掩码本身。
    const apiKeyInput = readString(body, "apiKey", { maxLength: 400 });
    const apiKey = apiKeyInput.trim()
      ? apiKeyInput.trim()
      : existing?.apiKey;
    if (!apiKey) {
      throw new PlatformError("invalid_request", "新建 provider 时必须提供 apiKey");
    }

    const upstreamBaseUrl = readString(body, "upstreamBaseUrl", {
      required: !existing,
      maxLength: 500,
    });
    const now = deps.now();
    await deps.providers.upsert({
      id,
      label:
        readString(body, "label", { maxLength: 100 }).trim() ||
        existing?.label ||
        id,
      upstreamBaseUrl: upstreamBaseUrl.trim() || existing?.upstreamBaseUrl || "",
      apiKey,
      protocol,
      enabled:
        typeof body["enabled"] === "boolean" ? (body["enabled"] as boolean) : existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return context.body(null, 204);
  });

  routes.delete("/providers/:id", async (context) => {
    await requireAdmin(context);
    await deps.providers.remove(context.req.param("id"));
    return context.body(null, 204);
  });

  // ── 模型单价 ──────────────────────────────────────────────
  routes.get("/prices", async (context) => {
    await requireAdmin(context);
    const records = await deps.prices.list();
    return context.json({
      prices: records.map((record) => ({
        modelId: record.modelId,
        input: formatMicros(record.inputMicrosPerMillion),
        output: formatMicros(record.outputMicrosPerMillion),
        cacheRead: formatMicros(record.cacheReadMicrosPerMillion),
        cacheWrite: formatMicros(record.cacheWriteMicrosPerMillion),
        updatedAt: record.updatedAt,
      })),
    });
  });

  routes.put("/prices/:modelId", async (context) => {
    await requireAdmin(context);
    const modelId = context.req.param("modelId").trim();
    if (!modelId) {
      throw new PlatformError("invalid_request", "modelId 不能为空");
    }
    const body = await readJsonObject(context);
    const existing = await deps.prices.findByModelId(modelId);
    const readOrKeep = (field: string, previous: Micros): Micros => {
      const raw = readString(body, field, { maxLength: 32 });
      return raw.trim() ? parsePriceMicros(raw, field) : previous;
    };
    await deps.prices.upsert({
      modelId,
      inputMicrosPerMillion: readOrKeep("input", existing?.inputMicrosPerMillion ?? 0),
      outputMicrosPerMillion: readOrKeep("output", existing?.outputMicrosPerMillion ?? 0),
      cacheReadMicrosPerMillion: readOrKeep("cacheRead", existing?.cacheReadMicrosPerMillion ?? 0),
      cacheWriteMicrosPerMillion: readOrKeep("cacheWrite", existing?.cacheWriteMicrosPerMillion ?? 0),
      updatedAt: deps.now(),
    });
    return context.body(null, 204);
  });

  routes.delete("/prices/:modelId", async (context) => {
    await requireAdmin(context);
    await deps.prices.remove(context.req.param("modelId"));
    return context.body(null, 204);
  });

  return routes;
}
