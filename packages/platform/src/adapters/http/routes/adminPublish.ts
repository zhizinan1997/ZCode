/**
 * 管理接口：模型发布设置与推送（specs/platform/model-publish.md）。
 *
 * - GET/PUT /publish：发布设置的全量读与全量写（唯一事实源是 published_* 表）；
 * - POST /publish/preview：生成目录但不写库，管理员先看摘要与 JSON；
 * - POST /publish/apply：生成并写入新 revision，客户端在一分钟内自动应用。
 *
 * 从上游拉模型列表在 adminCatalog（POST /providers/:id/fetch-models，一次性探测不落库），
 * 内置目录摘要在 GET /catalog/builtin——本文件只管"设置"与"推送"。
 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { ModelPublishService } from "../../../app/modelPublishService.js";
import type { Logger } from "../../log.js";
import { readBoolean, readJsonObject } from "../helpers.js";
import { createAdminGuard, type AdminResolver } from "./adminSupport.js";

export function createAdminPublishRoutes(deps: {
  readonly accounts: AccountService;
  readonly modelPublish: ModelPublishService;
  readonly logger: Logger;
}): Hono {
  const routes = new Hono();
  const requireAdmin: AdminResolver = createAdminGuard(deps.accounts);

  /** keepBuiltinProviders 缺省 true：默认保留厂商内置 provider，由管理员显式关闭。 */
  function readKeepBuiltinProviders(body: Record<string, unknown> | null): boolean {
    return body === null ? true : readBoolean(body, "keepBuiltinProviders", { default: true });
  }

  routes.get("/publish", async (context) => {
    await requireAdmin(context);
    const settings = await deps.modelPublish.readSettings();
    return context.json(settings);
  });

  routes.put("/publish", async (context) => {
    const admin = await requireAdmin(context);
    const body = await readJsonObject(context);
    const saved = await deps.modelPublish.saveSettings({
      settings: body,
      updatedBy: admin.user.id,
    });
    const modelCount = saved.providers.reduce(
      (total, provider) => total + provider.models.length,
      0,
    );
    deps.logger.info("模型发布设置已保存", {
      adminId: admin.user.id,
      providerCount: saved.providers.length,
      modelCount,
    });
    return context.json(saved);
  });

  routes.post("/publish/preview", async (context) => {
    await requireAdmin(context);
    const body = await readJsonObject(context).catch(() => ({}));
    const preview = await deps.modelPublish.preview({
      keepBuiltinProviders: readKeepBuiltinProviders(body),
    });
    return context.json(preview);
  });

  routes.post("/publish/apply", async (context) => {
    const admin = await requireAdmin(context);
    const body = await readJsonObject(context).catch(() => ({}));
    const result = await deps.modelPublish.apply({
      keepBuiltinProviders: readKeepBuiltinProviders(body),
      updatedBy: admin.user.id,
    });
    deps.logger.info("模型目录已推送", { revision: result.revision, adminId: admin.user.id });
    return context.json(result);
  });

  return routes;
}
