import type { ModelSelectionView } from "@zcode/services";

interface ProviderAvailabilityState {
  readonly source: "registry";
  readonly hydrated: boolean;
  readonly providerCount: number;
  readonly hasUsableProvider: boolean;
}

export function resolveProviderAvailabilityState(params: {
  modelSelectionView: ModelSelectionView | null;
}): ProviderAvailabilityState {
  const providers = params.modelSelectionView?.providers ?? [];
  return {
    source: "registry",
    hydrated: params.modelSelectionView !== null,
    providerCount: providers.length,
    hasUsableProvider:
      params.modelSelectionView !== null &&
      providers.some((provider) => provider.models.length > 0),
  };
}

/**
 * 启动时是否要弹出统一登录入口。
 *
 * 判定的是"有没有可用的调用能力"：已登录用户不需要再看到登录页，未登录且没有任何
 * 可用模型配置时才需要引导。
 *
 * 关于 providerFamilyDomain：它原本是"用户还没选厂商 family 就必须先选"的门禁。
 * 平台账号登录不涉及厂商 family 选择，登录态本身就意味着可用，所以这里改为
 * 只有"未登录"才因缺少 family domain 触发登录入口；已登录但 domain 为空的
 * 平台会话不再被无谓地弹回登录页。
 */
export function shouldOpenProviderAvailabilityLoginEntry(params: {
  user: unknown | null;
  providerFamilyDomain: string | null | undefined;
  hasUsableProvider: boolean;
}): boolean {
  if (params.user) {
    return false;
  }
  return !params.providerFamilyDomain || !params.hasUsableProvider;
}
