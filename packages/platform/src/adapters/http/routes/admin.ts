/**
 * 管理接口总装。
 *
 * 拆成多个子路由文件是为了让每个文件保持可读；它们共用同一套 admin 鉴权，
 * 因此在总装处按前缀平铺挂载，不额外引入层次。
 */
import { Hono } from "hono";
import type { AccountService } from "../../../app/accountService.js";
import type { BillingService } from "../../../app/billingService.js";
import type { CatalogService } from "../../../app/catalogService.js";
import type { PlanService } from "../../../app/planService.js";
import type { ReleaseService } from "../../../app/releaseService.js";
import type {
  GatewayProviderRepository,
  ModelPriceRepository,
  UsageRepository,
} from "../../../app/ports.js";
import { createAdminCatalogRoutes } from "./adminCatalog.js";
import { createAdminPlanRoutes } from "./adminPlans.js";
import { createAdminReleaseRoutes } from "./adminReleases.js";
import { createAdminUsageRoutes } from "./adminUsage.js";
import { createAdminUserRoutes } from "./adminUsers.js";

export interface AdminRoutesDependencies {
  readonly accounts: AccountService;
  readonly billing: BillingService;
  readonly catalog: CatalogService;
  readonly plans: PlanService;
  readonly releases: ReleaseService;
  readonly providers: GatewayProviderRepository;
  readonly prices: ModelPriceRepository;
  readonly usage: UsageRepository;
  readonly now: () => number;
  readonly newProviderId: () => string;
  readonly releasesDir: string;
}

export function createAdminRoutes(deps: AdminRoutesDependencies): Hono {
  const routes = new Hono();

  routes.route(
    "/",
    createAdminUserRoutes({
      accounts: deps.accounts,
      billing: deps.billing,
      plans: deps.plans,
    }),
  );
  routes.route(
    "/",
    createAdminCatalogRoutes({
      accounts: deps.accounts,
      catalog: deps.catalog,
      providers: deps.providers,
      prices: deps.prices,
      now: deps.now,
      newProviderId: deps.newProviderId,
    }),
  );
  routes.route(
    "/",
    createAdminUsageRoutes({
      accounts: deps.accounts,
      billing: deps.billing,
      usage: deps.usage,
    }),
  );
  routes.route("/", createAdminPlanRoutes({ accounts: deps.accounts, plans: deps.plans }));
  routes.route(
    "/",
    createAdminReleaseRoutes({
      accounts: deps.accounts,
      releases: deps.releases,
      releasesDir: deps.releasesDir,
    }),
  );

  return routes;
}
