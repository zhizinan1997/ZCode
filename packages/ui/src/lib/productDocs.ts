import { resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";

/**
 * 产品文档入口统一收口，避免不同菜单跳到不一致的文档站。
 *
 * 商业版域名边界：不再写死厂商文档站 zcode.z.ai，改为跟随构建期注入的平台服务地址；
 * 平台若没有托管 /docs，打开会是 404，而不是把用户带去厂商域名。
 */
export function resolveProductDocsUrl(): string {
  return `${resolveRuntimeZCodeEndpointOrigin()}/docs`;
}
