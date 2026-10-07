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
import { createAdminOperationRoutes } from "./adminOperations.js";
import { createAdminPlanRoutes } from "./adminPlans.js";
import { createAdminPublishRoutes } from "./adminPublish.js";
import { createAdminReleaseRoutes } from "./adminReleases.js";
import { createAdminUsageRoutes } from "./adminUsage.js";
import { createAdminUserRoutes } from "./adminUsers.js";
import { createAdminUserBillingRoutes } from "./adminUserBilling.js";
import { createAdminUserSubscriptionRoutes } from "./adminUserSubscriptions.js";
import type { OperationsService } from "../../../app/operationsService.js";
import type { ModelPublishService } from "../../../app/modelPublishService.js";
import type { Logger } from "../../log.js";

export interface AdminRoutesDependencies {
  readonly accounts: AccountService;
  readonly billing: BillingService;
  readonly catalog: CatalogService;
  readonly plans: PlanService;
  readonly releases: ReleaseService;
  readonly operations: OperationsService;
  readonly modelPublish: ModelPublishService;
  readonly providers: GatewayProviderRepository;
  readonly prices: ModelPriceRepository;
  readonly usage: UsageRepository;
  readonly now: () => number;
  readonly newProviderId: () => string;
  readonly releasesDir: string;
  readonly logger: Logger;
}

export function createAdminRoutes(deps: AdminRoutesDependencies): Hono {
  const routes = new Hono();

  routes.route(
    "/",
    createAdminUserRoutes({
      accounts: deps.accounts,
      billing: deps.billing,
      operations: deps.operations,
      plans: deps.plans,
    }),
  );
  routes.route(
    "/",
    createAdminUserBillingRoutes({
      accounts: deps.accounts,
      billing: deps.billing,
      operations: deps.operations,
    }),
  );
  routes.route(
    "/",
    createAdminUserSubscriptionRoutes({
      accounts: deps.accounts,
      operations: deps.operations,
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
      catalog: deps.catalog,
      prices: deps.prices,
      now: deps.now,
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
  routes.route(
    "/",
    createAdminOperationRoutes({
      accounts: deps.accounts,
      operations: deps.operations,
    }),
  );
  routes.route(
    "/",
    createAdminPublishRoutes({
      accounts: deps.accounts,
      modelPublish: deps.modelPublish,
      logger: deps.logger,
    }),
  );

  return routes;
}
