# RCode 商业版平台规格

本目录定义 RCode 商业版的四条主链路。客户端仍是发给用户的 Electron 安装包（exe/dmg），agent 在用户本机运行；服务端只提供账号、配置下发、模型网关、计费与更新分发。

## 范围

保留：

1. 账号登录（[account.md](account.md)）
2. 模型调用（[model-catalog.md](model-catalog.md) + [gateway-billing.md](gateway-billing.md)）
3. 余额与套餐（[gateway-billing.md](gateway-billing.md)）
4. 客户端更新（[release-update.md](release-update.md)）

关闭并清理（本仓库原有、绑定厂商后端的特性）：

- Coding Plan 订阅/购买/额度/重置
- 闲时任务（off-peak）
- 官方 MCP
- 遥测上报（ARMS、OTLP）
- 官方插件市场
- 对话分享
- 反馈上传

清理时同步删除 UI 入口、服务实现与文档/技能中的引用。

## 状态所有者

| 事实 | 唯一所有者 | 客户端角色 | 服务端角色 |
| --- | --- | --- | --- |
| 用户身份、角色 | 平台数据库 | 只读缓存（`user_info`） | 唯一写入方 |
| 登录令牌 | 平台（签发） | 持有（加密存储） | 校验 |
| 余额、流水 | 平台数据库 | 只读展示 | 唯一写入方 |
| 套餐与权益 | 平台数据库 | 只读展示 | 唯一写入方 |
| 模型单价 | 平台数据库 | 不感知 | 唯一写入方 |
| 模型目录（providers/models） | 平台数据库 | 只读缓存 | 唯一写入方 |
| 上游 API key | 平台服务端 env/DB | 不持有 | 唯一持有方 |
| 用量事实 | 网关（平台） | 本机另有一份本地用量，仅供本地统计 | 唯一权威来源 |
| 客户端版本与产物 | 平台发布库 | 消费 | 唯一发布方 |
| 对话、项目文件、本机设置 | 用户本机 | 唯一所有者 | 不接触 |

约束：客户端上的一切限制都只是 UX。客户端可被用户修改，因此**任何授权与计费判定都必须在服务端完成**。

## 端到端时序

### 登录

```
用户 → 客户端登录表单 → Host AuthService → POST /api/auth/login
平台 → 校验密码 → 签发令牌 → 返回 {token, user, expiresAt}
Host → persistOAuthSession 写 credential（active_provider=platform, user_info, zcodejwttoken=令牌）
Host → 刷新 provider 配置与登录态 → renderer 进入主界面
```

### 模型调用与计费

```
用户发消息
→ agent 解析 provider 配置 → baseUrl = <platform>/api/v1/gateway/<providerId>
→ transport 注入 Authorization: Bearer <令牌>
→ 网关：验令牌 → 查套餐/模型权限 → 查余额 → 预扣 reserve
→ 转发上游（注入平台 key）→ 流式响应 tee 出 usage
→ 结算 settle → 写 usage_records + ledger（按请求 id 幂等）
→ 余额不足：402，不转发
```

### 目录下发与更新

```
管理员在后台改模型目录 → revision 严格 +1 → 写入 catalog
客户端 Host：每 60s 检查 → 下载 catalog → 校验 revision 与 schema → 写 active 缓存
agent：目录文件变更 → 重新解析 provider registry（无需重启）

管理员发布新版本 → 平台登记产物与 sha512 → 生成 YAML manifest
客户端：启动时 + 每小时检查 manifest → 比版本 → 下载 → 校验 sha512 → 提示安装
```

## 服务端形态与部署

服务端是**单一进程**（`packages/platform`），同时承担账号、模型网关、计费、管理后台与客户端发布。
部署形态是一个 Docker 容器加一个数据卷，对外只需要一个域名：

```
浏览器 / 客户端  ──HTTPS──▶  反向代理（可选 Caddy，自动 TLS）──▶  平台容器 :3100
                                                                    │
                                                                    └── /data（数据卷）
                                                                        ├── platform.sqlite
                                                                        └── releases/<版本>/
```

编排与上线步骤见 [deploy/README.md](../../deploy/README.md)。关键约束：

- **一个域名覆盖全部通信**：客户端把 `ZCODE_BASE_URL` 指向它，模型调用、目录拉取、更新检查都走它。
- **端口默认只发布到宿主回环地址**：平台持有上游 API key 与全部用户余额，暴露到公网必须是有意为之。
- **`ZCODE_PLATFORM_PUBLIC_ORIGIN` 必须显式配置**：平台用它生成客户端要拉取的绝对地址。

## 接口清单

| 路径 | 认证 | 用途 |
| --- | --- | --- |
| `POST /api/auth/login` | 无 | 登录换取令牌 |
| `POST /api/auth/logout` · `GET /api/auth/me` · `POST /api/auth/password` | 用户令牌 | 登出、当前用户、自助改密 |
| `ALL /api/v1/gateway/:providerId/*` | 用户令牌 | 模型网关：转发上游、计量、限额 |
| `GET /api/v1/client/configs` | 无 | 客户端配置入口，返回带 revision 的目录地址 |
| `GET /api/v1/catalog/:revision.json` | 无 | 模型目录全文（内容不可变，可长缓存） |
| `GET /api/v1/releases/electron/manifest` | 无 | 客户端更新清单（YAML） |
| `GET /api/v1/billing/me` | 用户令牌 | 客户端展示余额、套餐与用量 |
| `GET /releases/electron/:version/:fileName` | 无 | 安装包下载 |
| `GET|POST /api/admin/users` · `GET|PATCH /api/admin/users/:id` | 管理员 | 用户管理 |
| `POST /api/admin/users/:id/recharge` · `/adjust` · `/password` · `/subscription` | 管理员 | 余额、密码、套餐发放 |
| `GET /api/admin/users/:id/ledger` · `/usage` · `/reconcile` | 管理员 | 流水、调用记录、对账 |
| `GET|PUT /api/admin/catalog` | 管理员 | 模型目录编辑（revision 严格递增） |
| `GET|PUT|DELETE /api/admin/providers[/:id]` | 管理员 | 上游 provider（API key 只写不读） |
| `GET|PUT|DELETE /api/admin/prices[/:modelId]` | 管理员 | 模型单价 |
| `GET|POST|PATCH|DELETE /api/admin/plans[/:id]` | 管理员 | 套餐定义 |
| `GET /api/admin/usage` · `/usage/totals` · `/usage/by-user` | 管理员 | 用量看板 |
| `GET|PUT|DELETE /api/admin/releases[/:id]` | 管理员 | 发布登记与产物上传（原始二进制 PUT） |
| `GET /` · `/console/*` | 无（页面内自行登录） | 管理后台网页端 |

## 尚未实现（与本期范围的差额）

以下项在计划中属于后续里程碑，当前**未实现**，不应被当作已完成：

- **客户端内的余额与套餐展示**：服务端已提供 `/api/v1/billing/me`，但客户端还没有把它接到界面上。
  现有的额度面板仍读厂商数据源。
- **按套餐隐藏模型**：目录是全站共享的一份 JSON，做不到按用户过滤；当前只能"模型可见、调用时由网关拒绝"。
- **厂商功能的代码删除**：Coding Plan、闲时任务、官方 MCP、对话分享、反馈上传等入口仍在客户端里，
  只是不再出现在首屏。硬编码的厂商域名已改为跟随客户端服务地址（见 `resolveOfficialPluginBaseUrl`），
  但 `packages/desktop/src/main/remoteCdn.ts` 的 CDN 默认值仍指向厂商域名，需要时用
  `ZCODE_CDN_BASE_URL` 覆盖。
- **Windows 代码签名与 macOS 公证**：仓库里没有签名配置，产物默认未签名。

## 验收基线

以下场景已端到端验证通过（`packages/platform` 单测与进程级冒烟）：

1. 管理员开户后，用户用邮箱密码登录成功；密码错误不签发令牌。
2. 登录后能选到平台配置的模型并发起对话。
3. 该次调用在管理后台可见，且扣费金额与单价表一致。
4. 余额耗尽后调用被拒（402），客户端给出可理解的提示。
5. 管理员充值后无需重启客户端即可恢复调用。
6. 管理员修改模型目录后，客户端不升级即可看到变化。
7. 旧版本客户端能检测到新版本并下载产物（未签名阶段为手动安装）。
