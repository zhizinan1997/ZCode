# 商业版域名边界

本规格定义商业版客户端与第三方厂商域名之间的边界，以及该边界在代码里的强制点。

产品原则：**商业版客户端不得私下访问第三方厂商域名**。客户端的一切对外通信都必须走
`ZCODE_BASE_URL` 指向的平台服务；厂商域名只允许出现在开源版/开发 flavor 的兼容回退里。

## 禁止域名清单

| 域名                               | 原用途                                                    | 商业版处置                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zcode.z.ai`                       | 厂商平台：目录、更新、遥测改写源                          | 禁止。默认值已改空；production flavor 未配置 `ZCODE_BASE_URL`/`ZCODE_ENDPOINT_ORIGIN` 时 fail fast；仅作为历史 URL 的改写源（`rewriteZCodeEndpointUrl`）保留常量 |
| `chat.z.ai`                        | 厂商 OAuth 授权页 / userinfo                              | 禁止。厂商 OAuth provider 已从运行时配置下线（`createOAuthRuntimeConfig` 返回空列表）                                                                            |
| `api.z.ai`                         | 厂商业务 API（Team Plan、API key 交换、Coding Plan 用量） | 禁止。CLI 不再写死该域名；未显式配置 `ZAI_BUSINESS_BASE_URL` 时拒绝请求                                                                                          |
| `bigmodel.cn` / `open.bigmodel.cn` | BigModel 管理页 / 模型端点                                | 禁止作为默认值来源；仅在显式配置 `BIGMODEL_API_BASE_URL` 或平台目录改写后使用                                                                                    |
| `cdn-zcode.z.ai`                   | 厂商 CDN（插件资源、远程资源）                            | 禁止。官方插件资源跟随 `resolveOfficialPluginBaseUrl()`（= 平台 origin）；远程资源用 `ZCODE_CDN_BASE_URL` 覆盖（默认值仍待清理，见下）                           |
| `z.ai`                             | 厂商官网（套餐购买、插件作者链接）                        | 禁止。套餐购买/预设入口已删；官方插件作者改为 RCode                                                                                                              |

## 机制

### 1. 运行时 fail fast（`packages/shared/src/zcodeEndpoint.ts`）

- `DEFAULT_ZCODE_ENDPOINT_ORIGIN = ""`：默认服务地址不再指向厂商域名。
- `LEGACY_ZCODE_ENDPOINT_ORIGIN = "https://zcode.z.ai"`：只服务开发/开源 flavor 的兼容回退，
  以及把历史产物里写死的厂商 URL 改写到平台地址（`rewriteZCodeEndpointUrl`）。
- `resolveDefaultZCodeEndpointOrigin()`：`ZCODE_PRODUCT_FLAVOR === "production"` 且没有
  `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN` 时抛错；`preview`（开发）flavor 保持原有回退行为。
- 所有下游解析（`resolveZCodeEndpointOrigin`、`resolveRuntimeZCodeEndpointOrigin`、
  `buildRuntimeZCodeEndpointUrls`、`resolveOfficialPluginBaseUrl`、子进程 env 注入等）都经过这条路径。

### 2. 构建期 fail fast（`packages/desktop/scripts/bundle.mjs`）

production 身份的安装包在打包入口校验 `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN`
（含 `.env` / `.env.local`）：缺失直接退出并提示。CI（`.github/workflows/release.yml`）
始终注入该变量，值来自仓库变量 `ZCODE_BASE_URL`，未设置时使用默认 `https://rcode.zhizinan.top`。

### 3. 厂商 OAuth 下线

`packages/services/src/oauth/runtimeConfig.ts` 返回 `providers: []`，
`createOAuthProviderAdapters` 也不再创建 Z.ai / BigModel adapter。
`startOAuth("zai" | "bigmodel")` 会因找不到 adapter 直接抛错，客户端不存在任何打开厂商授权页的路径。
平台账号（`PLATFORM_PROVIDER_ID`）是唯一登录方式，走密码表单直连平台，不经过 adapter 体系。

### 4. 端点上仍保留的厂商字面量（仅有条件可达）

`DEFAULT_ZAI_OAUTH_ORIGIN`、`DEFAULT_ZAI_BUSINESS_BASE_URL`、`DEFAULT_BIGMODEL_API_ORIGIN`
仍是各自解析函数的兜底值，只有开源版遗留的厂商账号链路会消费它们（Coding Plan 订阅/用量、
legacy 配置迁移）。这些链路在商业版没有入口，但代码尚未删除；删除它们是一次独立清理
（见 specs/platform/README.md 的「尚未实现」）。

## 保留的内部遥测及理由

| 出口                                                                               | 端点来源                       | 判定                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数仓事件上报（`ZCODE_TELEMETRY_REPORT_ENDPOINT`）                                  | 运行时环境变量，构建产物不内嵌 | 保留。仓库内不含任何厂商上报域名；端点由部署方（公司内部数仓）提供，未配置即停用。事件 URL 还会经 `rewriteZCodeEndpointUrl` 把历史厂商 origin 改写到平台 origin |
| ARMS RUM（`ZCODE_ARMS_RUM_ENDPOINT`）                                              | 运行时环境变量，未配置即停用   | 保留。阿里云 ARMS 是公司内部观测设施，不是厂商（Z.ai/BigModel）域名；端点由部署方注入                                                                           |
| Agent OTLP（`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`） | 运行时环境变量                 | 保留。与数仓同源，未配置即不上报                                                                                                                                |
| 本地用量与日志                                                                     | 用户本机                       | 保留，不出网                                                                                                                                                    |

## 验收

1. production flavor 构建缺 `ZCODE_BASE_URL` 时：`pnpm bundle:desktop` 失败；运行期解析抛
   「商业版未配置服务地址」而不是连到 `zcode.z.ai`。
2. `grep -rn "zcode.z.ai\|chat.z.ai\|api.z.ai\|open.bigmodel.cn\|bigmodel.cn" packages/shared packages/services packages/ui apps/zcode-cli`
   的剩余命中都属于「端点上仍保留的厂商字面量」或测试夹具，且不在任何商业版可达路径上。
3. `startOAuth("zai")` 在客户端返回 provider 不存在，不打开浏览器。
4. 未配置 `ZCODE_TELEMETRY_REPORT_ENDPOINT` / `ZCODE_ARMS_RUM_ENDPOINT` 时客户端零遥测出网。
