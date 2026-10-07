/**
 * platform 模块清单：ZCode 商业版控制面（账号、模型目录、计费、发布）。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外只暴露 contract.ts。
 *
 * 刻意不 requires 任何既有模块：平台是独立服务，与 desktop/services 之间只有 HTTP 契约，
 * 没有代码依赖，这样两边的演进互不牵连。
 */
export const platformModule = {
  id: "platform",
  requires: [],
  provides: ["platform-http-api", "platform-account-service"],
  publicEntrypoints: ["contract.ts"],
} as const;
