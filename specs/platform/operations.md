# 管理后台与平台运营

管理后台（`packages/platform/console`，无构建步骤的原生 ES 模块静态页）与平台运营能力：审计日志、系统设置、兑换码、用户 API Key。

## 状态所有者

| 事实                            | 唯一所有者                                       | 管理后台角色                |
| ------------------------------- | ------------------------------------------------ | --------------------------- |
| 审计日志                        | 平台数据库 `audit_logs`                          | 只读查询                    |
| 系统设置（覆盖 env 的运营参数） | 平台数据库 `system_settings`                     | 读写（写走服务）            |
| 兑换码定义与核销                | 平台数据库 `redeem_codes` / `redeem_redemptions` | 管理/生成                   |
| 用户 API Key                    | 平台数据库 `api_keys`                            | 代用户生成/吊销；平台侧校验 |
| 令牌与登录态                    | 平台数据库 `sessions`                            | 只读                        |

## 系统设置（system_settings）

- 单行键值存储：`key TEXT PRIMARY KEY`、`value TEXT NOT NULL`、`updated_at`、`updated_by`。
- 当前支持的键（service 层定义常量与类型，未知键拒绝写入）：
  - `forceUpdateMinimalVersion`：string，`""` 表示不启用；非空时必须是合法版本号。经 `/api/v1/client/configs` 的 `configs.forceUpdate.minimalVersion` 下发，客户端 `getForceUpdateMinimalVersionFromConfig` 已消费该形状。
  - `allowSelfRegistration`：`"true" | "false"`（默认 false；兑换码注册接口据此开关）。
- 设置读取优先级：DB > env 默认。service 在启动时读一次并缓存，写路径更新 DB 后同步刷新缓存（同进程内一致；单进程部署是当前唯一形态）。
- 变更一律写审计日志。

## 审计日志（audit_logs）

- 记录敏感管理操作：登录（成功）、登出、创建/修改/停用用户、重置密码、改密、充值、调整、套餐发放/撤销、套餐增删改、上游增删改、单价增删、目录发布、发布上传/删除、兑换码生成/吊销、API Key 生成/吊销、设置修改、网关按 API Key 鉴权失败。
- 行结构：`id`（`aud_` 前缀）、`actor_user_id`（可空：失败登录无身份）、`action`（`user.create` 等稳定字符串）、`target_type`、`target_id`、`detail`（JSON 文本，禁止存明文密码/key）、`created_at`。
- 只追加，不修改；管理后台只读，无删除入口。
- 记录失败不能让原操作失败：审计是旁路观察者，写失败只打 warn 日志。

## 兑换码

- `redeem_codes`：`code`（人类可读大写串，唯一）、`amount_micros`、`max_redemptions`、`redeemed_count`、`expires_at`（可空）、`created_by`、`revoked_at`、`created_at`。
- `redeem_redemptions`：`code_id`、`user_id`、`amount_micros`、`redeemed_at`；`(code_id, user_id)` 唯一——同一用户对同一码只能核销一次。
- 核销 = 在 ledger 写 `recharge` 分录（`note` 注明兑换码），余额唯一事实源不变。核销、吊销在服务层同一事务内完成，防超发。
- 未登录不可查询码的存在性：核销接口必须先鉴权。

## 用户 API Key

- `api_keys`：`id`（`key_` 前缀）、`user_id`、`key_hash`（scrypt）、`key_hint`（末 4 位）、`name`、`created_at`、`last_used_at`、`revoked_at`。
- 明文 key 形如 `zcpk_<32位base64url>`，**只在创建响应里出现一次**，DB 只存哈希；管理列表只回显 hint。
- 用途：`Authorization: Bearer zcpk_...` 打到 `/api/v1/gateway/*`，网关按该用户身份计费。会话令牌 30 天过期，API Key 长期有效直到吊销，适合 CLI/第三方工具。
- 网关鉴权顺序：先按会话令牌解析；前缀为 `zcpk_` 时改走 API Key 校验（哈希查找失败即 401，失败记审计）。

## 管理后台形态

- 纯静态、无构建：ES 模块按页面拆文件，`app.js` 只做路由注册与全局事件，页面渲染器注册进 `SCREENS` 注册表。
- 共享基建在 `api.js`：令牌、`api()` fetch 封装、`esc/fmt*` 格式化、`openModal/closeModal`（替代 window.prompt/confirm）、`renderPagination`（服务端分页）、表格容器类 `table-scroll`（移动端横向滚动）。
- 列表一律服务端分页（limit/offset + total），不在前端截断。
- 401/403 统一由 `handleAuthFailure` 回登录页；登出与令牌过期都走它。
- 上游 API key 只写不读（掩码回显）；审计详情不得包含密码、明文 key。

## 接口清单（新增/变更）

| 路径                                 | 方法     | 说明                                                                      |
| ------------------------------------ | -------- | ------------------------------------------------------------------------- |
| `/api/admin/users`                   | GET      | `q`（邮箱/显示名模糊）、limit/offset 分页；返回 `users`+`total`           |
| `/api/admin/users`                   | POST     | 新建用户（含审计）                                                        |
| `/api/admin/users/:id`               | PATCH    | 支持 `displayName`、`email`、`role`、`status`；最后一管理员不可降级/停用  |
| `/api/admin/users/:id`               | DELETE   | 删除用户（含余额清零审计；会话、API Key 级联失效）                        |
| `/api/admin/users/bulk-subscription` | POST     | 批量发放套餐 `{planId, userIds}`                                          |
| `/api/admin/usage`                   | GET      | 全站调用明细（服务端分页、`sinceDays`、`userId`）                         |
| `/api/admin/ledger`                  | GET      | 全站流水（分页、`userId` 可选）                                           |
| `/api/admin/usage/by-model`          | GET      | 按模型聚合（sinceDays）                                                   |
| `/api/admin/overview`                | GET      | 概览聚合：totals、今日充值/消费、平台负债（用户余额合计）、未配价模型列表 |
| `/api/admin/settings`                | GET/PUT  | 系统设置读写（PUT 全量提交，逐键校验）                                    |
| `/api/admin/audit`                   | GET      | 审计日志（分页、按 action 过滤）                                          |
| `/api/admin/redeem-codes`            | GET/POST | 列表 / 生成（批量、额度、有效期、次数）                                   |
| `/api/admin/redeem-codes/:id`        | DELETE   | 吊销（已核销次数保留）                                                    |
| `/api/admin/api-keys`                | GET/POST | 全站 Key 列表 / 代用户创建                                                |
| `/api/admin/api-keys/:id`            | DELETE   | 吊销                                                                      |
| `/api/v1/redeem`                     | POST     | 用户令牌核销兑换码（客户端/管理端同用）                                   |
| `/api/v1/api-keys`                   | GET/POST | 用户自助管理自己的 Key                                                    |
| `/api/v1/api-keys/:id`               | DELETE   | 用户吊销自己的 Key                                                        |

## 时序：兑换码核销（防超发）

```
用户 → POST /api/v1/redeem {code}
服务：验登录 → BEGIN IMMEDIATE → 行锁读 code
  → 校验：未吊销、未过期、redeemed_count < max_redemptions、该用户未核销过
  → UPDATE redeemed_count = redeemed_count + 1 → INSERT redemption → INSERT ledger(recharge)
  → COMMIT → 返回入账金额
```

## 时序：网关按 API Key 鉴权

```
客户端 → Authorization: Bearer zcpk_...
网关路由：识别 zcpk_ 前缀 → 哈希查找 api_keys → 未吊销 → 加载 user（active）
  → 以该 user.id 进入既有网关链路（资格/余额/预扣/结算）
失败 → 401 + 审计
```
