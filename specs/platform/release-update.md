# 客户端更新推送

客户端已有的自动更新能力完全复用：仓库里的 `ManifestUpdateProvider` 负责解析，服务端只需按契约提供 manifest 与产物。**客户端零改动**。

## 客户端已实现的契约（服务端必须严格遵守）

请求：

```
GET <endpointOrigin>/api/v1/releases/electron/manifest
      ?platform=<windows-x86_64|windows-aarch64|darwin-x86_64|darwin-aarch64|linux-*>
      &device_mid=<uuid>
      &channel=<1=stable | 3=preview>
Headers:
  Accept: application/x-yaml,text/yaml,text/plain,*/*
  X-Platform: <platform>
  X-Release-Channel: <1|3>
  X-Device-Mid: <uuid>
```

响应：**YAML**，顶层必须是对象且含字符串 `version`。可用字段：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `version` | 是 | 版本号，客户端用 semver 与本地版本比较 |
| `files` | 是 | 数组，每项 `{url, sha512}`（也接受 `sha2`） |
| `files[].url` | 是 | 相对路径按 manifest 同源根解析（`new URL(url, <origin>/)`），也可给绝对 URL |
| `packages` | 否 | 按架构索引 `{[arch]: {path, ...}}`，`path` 同样按同源解析 |
| `releaseName` / `releaseDate` / `releaseNotes` | 否 | 更新弹窗展示用 |

硬性约束：

- 任何文件项**缺少 `sha512`（或 `sha2`）都会被客户端拒绝**并报错，这是唯一的完整性校验，服务端必须正确计算。
- 客户端解析不到文件列表（既无 `files` 也无 legacy `path`）会抛错。
- Linux 还会按安装包类型过滤后缀（`.appimage` / `.deb` / `.rpm` / `.pkg.tar.zst`），缺对应格式同样报错。本期只发 Windows 与 macOS，Linux 不承诺。
- 下载地址默认取自 manifest 同源，所以产物放在 manifest 同一站点即可。

## 服务端接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/releases/electron/manifest` | 按 `platform`/`channel` 返回 YAML manifest |
| GET | `/releases/electron/<version>/<filename>` | 静态产物下载 |
| POST | `/api/admin/releases` | 管理员登记一次发布（版本、各平台文件名、发布说明、通道） |
| GET | `/api/admin/releases` | 发布历史 |

manifest 的 `files[].url` 使用相对路径（`/releases/electron/<version>/<filename>`），由平台按登记记录生成。

## 版本与通道

- 两个通道：`stable`（channel=1）与 `preview`（channel=3）。客户端的通道由设置项决定，默认 stable。
- 版本比较由客户端用 semver 完成，服务端只需保证登记的版本号严格递增、且与安装包内的 `version` 一致。
- 强制升级：客户端会读 `GET /api/v1/client/configs` 的 `forceUpdate.minimalVersion`。需要强制时由管理后台写入该字段，客户端启动时若低于下限会弹窗并阻止使用。

## 签名（当前状态与影响）

- **Windows**：仓库 `electron-builder.config.js` 中没有**任何**签名配置，产物默认未签名，会被 SmartScreen 拦截。
- **macOS**：`notarize: false`，且 Squirrel.Mac 会校验应用签名。**未签名/未公证的更新会被系统拒绝安装**，自动更新在这种情况下不可用。
- 因此当前阶段（无证书）的交付方式是：**产物手动分发给内测用户**，manifest 仍然提供以便客户端能检测到新版本，但 macOS 上的自动安装要等证书到位。

证书到位后需要补的配置：Windows 侧加 `win.certificateFile` / `certificatePassword`（或 `CSC_LINK`）；macOS 侧设 `ZCODE_ENABLE_MAC_SIGN=1` + `APPLE_SIGNING_IDENTITY`，并自建公证与装订（stapling）流水线——仓库里没有 CI 文件，这一步需要从零搭建。

## 构建期必须做的事

打包时**必须**把平台地址烘进产物，否则客户端仍会请求厂商域名：

- `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN` 需在构建时注入 main / preload / renderer 三处（`tsup.config.ts` / `vite.config.ts` 的 define）。
- 原因：production 构建下 `SetRCodeEndpointOverride` 命令是 no-op，且 packaged 应用会忽略 `ZCODE_UPDATE_FEED_URL`，运行期无法改指向。

## 验收

1. 登记一个更高版本后，运行中的旧客户端在启动或下一次轮询时检测到更新。
2. manifest 缺少 `sha512` 时客户端拒绝该更新并报错。
3. 产物 sha512 与 manifest 不一致时，客户端下载后校验失败，不安装。
4. 通道切换后（stable/preview）取到对应通道的版本。
5. 未签名产物在 Windows 上能下载但需用户手动确认安装；macOS 上自动安装被系统拒绝（预期行为，记录在案）。
