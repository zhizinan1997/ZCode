# 账号体系

替换原有的 Z.ai / BigModel 厂商 OAuth 登录，改用平台自有账号。客户端仍是单用户本机应用，不涉及多租户隔离。

## 产品规则

- 登录方式：**邮箱 + 密码**。
- **不开放自助注册**。账号一律由管理员在管理后台创建。
- 密码重置由管理员执行（本期不做邮件通道）。
- 角色两类：`admin`（管理后台全权限）、`user`（普通用户）。
- 用户可以属于多个套餐，但同一时刻只有一个生效套餐（见 [gateway-billing.md](gateway-billing.md)）。
- 停用（`disabled`）的用户不能登录，已签发的令牌立即失效。

## 接口

### 平台侧

| 方法   | 路径                                 | 说明                                                          |
| ------ | ------------------------------------ | ------------------------------------------------------------- |
| POST   | `/api/auth/login`                    | 入参 `{email, password}`；成功返回 `{token, expiresAt, user}` |
| POST   | `/api/auth/logout`                   | 客户端登出，令牌加入撤销列表                                  |
| GET    | `/api/auth/me`                       | 校验令牌并返回当前用户与角色                                  |
| POST   | `/api/auth/password`                 | 修改自己的密码（需原密码）                                    |
| GET    | `/api/admin/users`                   | 分页列表，支持 `q`（邮箱/显示名模糊搜索）、`limit`、`offset`  |
| POST   | `/api/admin/users`                   | 管理员创建用户（邮箱、密码、角色、初始余额）                  |
| POST   | `/api/admin/users/:id/password`      | 管理员重置密码                                                |
| PATCH  | `/api/admin/users/:id`               | 管理员改 `displayName`、`email`、`role` 或 `status`           |
| DELETE | `/api/admin/users/:id`               | 管理员删除用户（级联清理会话与 API Key）                      |
| POST   | `/api/admin/users/bulk-subscription` | 批量发放套餐 `{planId, userIds}`                              |

自我保护：系统必须始终保留至少一名可用管理员。当目标用户是最后一个 `active` 管理员时，`PATCH` 把 `role` 降为 `user`、把 `status` 改为 `disabled`、以及 `DELETE` 该用户都会被拒绝（`conflict`）。管理员任何时候都不能停用/降级/删除自己（一律 `403 forbidden`，见 [security-hardening.md](security-hardening.md) B2，本条以该文件为准）。

失败语义：邮箱不存在、密码错误、账号停用一律返回同一个 `401 invalid_credentials`，不区分原因（避免账号枚举）。

### 客户端侧

- 新增 provider id：`platform`。
- 复用现有 `IOAuthService` 通道与 `persistOAuthSession` 写入逻辑，**写的 credential key 与原厂商登录完全一致**：
  - `oauth:active_provider` = `"platform"`
  - `oauth:platform:user_info` = `{id, email, displayName, role}` 的 JSON
  - `zcodejwttoken` = 平台令牌

这样下游所有依赖登录态的代码（provider availability、plan identity、启动登录门禁、store 的 `user`）无需修改。

- `useOAuth.startLogin` 的语义从"打开浏览器并轮询"改为"提交邮箱密码表单"，`:state` 与 deep link 回调路径保留但登录不再走它。
- 登录后立即触发一次模型目录刷新与余额查询（见另外两份 spec）。

## 状态与存储

| 数据                       | 存放位置                                   | 备注                                        |
| -------------------------- | ------------------------------------------ | ------------------------------------------- |
| 邮箱、密码哈希、角色、状态 | 平台数据库 `users`                         | 新写入一律 scrypt；历史 bcrypt 记录只读兼容 |
| 登录会话                   | 平台数据库 `sessions`                      | 支持撤销、有过期时间                        |
| 令牌                       | 客户端 credential（AES-256-GCM，既有机制） | 明文只在进程内存                            |

密码哈希：平台写入一律是 `node:crypto` 的 `scrypt`，每个用户独立随机 salt，参数固定写入记录（`N=16384, r=8, p=1, keylen=64`），校验用 `timingSafeEqual`。历史 bcrypt 记录同样可校验，见下节。

令牌：HMAC-SHA256 签名的紧凑令牌，载荷含 `userId`、`role`、`sessionId`、`exp`。签名密钥来自服务端环境变量，缺失时服务端拒绝启动（不允许用默认值兜底）。

## 遗留 bcrypt 兼容

背景：平台自建账号一律以 scrypt 存储，但迁移过来的历史用户数据里 `users.password_hash` 是 bcrypt 记录。校验必须两种格式都认，否则老用户无法登录。

### 存储格式识别

`password_hash` 是单列 TEXT，两种格式靠前缀区分，不需要加列、不需要迁移：

| 前缀                                    | 格式                               | 来源                             |
| --------------------------------------- | ---------------------------------- | -------------------------------- |
| `scrypt$`                               | `scrypt$N$r$p$salt$hash`（base64） | 平台写入（建号、重置、改密、升级） |
| `$2a$` · `$2b$` · `$2y$`（60 字符）     | 标准 bcrypt，cost 由记录自带       | 历史数据，只读                   |

- 判定按整串格式，不做前缀猜测：不匹配任一格式一律校验失败（返回 `false`，不抛异常），与既有"损坏记录表现为登录失败"一致。
- 平台**不提供 bcrypt 写入入口**：`hashPassword` 永远产出 scrypt，bcrypt 分支只存在于 `verifyPassword`。
- 上述三个 revision 之外的变体（如 `$2x$`）不接受。底层库对这类输入会抛错，适配层必须捕获并转成 `false`，不能让异常穿透到登录路径。
- API Key 校验与密码校验复用同一对函数（`operationsService.ts`），因此 bcrypt 分支对它同样可达；但 `api_keys.api_key_hash` 只由 `hashPassword` 写入，现实中不会出现 bcrypt 记录。

### 登录时的无感升级

bcrypt 记录校验成功后，登录流程把该用户的 `password_hash` 重写为 scrypt，用户无感知。事件顺序：

```
login(email, password)
  → findByEmail
      └─ 不存在：假哈希校验一次 → 401（枚举防护，不变）
  → verifyPassword(password, stored)        # 按前缀分派 scrypt / bcrypt
      └─ 失败：401 invalid_credentials
  → status !== "active" → 401               # 与既有一致：先验密码再看状态
  → 记录是 bcrypt 且明文满足现行强度策略：UPDATE users SET password_hash = scrypt(...)
  → sessions.insert → 签发令牌 → 200
```

规则与边界：

- **升级写入只有登录这一条路径**。改密与管理员重置本来就走 `hashPassword`，天然产出 scrypt，不需要额外分支。
- **升级条件包含强度校验**：只有明文满足 `validatePasswordStrength` 才写回。历史弱密码（例如不足 8 位）登录**照常成功**，只是保持 bcrypt 记录不动——写入路径只有一套策略，不为升级开例外。
- **幂等**：只在记录格式为 bcrypt 时触发；并发登录各自写入自己的 scrypt 记录，两者都能校验，last-write-wins 无副作用。
- 升级写入失败等同于登录失败（与 `sessions.insert` 同一故障面），不做"吞掉错误继续登录"的兜底。

### 枚举防护的残余差异

`login` 对不存在的邮箱走一次等价代价的假哈希校验，避免用响应耗时区分"账号不存在"与"密码错误"。bcrypt 记录的校验成本来自记录自带的 cost（如 `$2a$10$`），与假哈希的 scrypt 参数不同，因此**在遗留记录升级完成前，响应耗时仍可能区分这两类账号**。该差异随用户首次登录升级而收敛；需要立即消除时由管理员重置该用户密码。

### 边界

- bcrypt 的 72 字节截断是格式固有语义：历史记录按截断后的密码校验，与其原实现一致。新的 scrypt 记录不受此限制。
- **cost 上限 16（含）**：bcrypt 的计算量是 2^cost，而这个值来自存储记录而不是调用方。不设上限时一条损坏记录（如 `$2b$31$`）就能让登录请求占住进程数天——纯 JS 实现下 cost 31 约合 2.5 天。纯 JS 下 cost 16 已需约 6.5 秒，超过它的记录不可能来自任何可用的历史系统，因此按损坏记录处理（登录失败，由管理员重置密码恢复，与其它损坏记录的处置一致）。
- 不做：bcrypt 新写入、cost 调整、离线批量升级（只有哈希没有明文，无法批量重算），以及为 bcrypt 记录单独放宽密码策略。

## 客户端实现

平台登录**不是 OAuth**：凭据由表单提交给 host，host 直接向平台换取会话。不打开浏览器，没有 deep link 回调。

| 项          | 取值                          | 说明                                                       |
| ----------- | ----------------------------- | ---------------------------------------------------------- |
| provider id | `platform`                    | 出现在 provider 体系里，只为复用凭据命名空间与启动恢复链路 |
| 访问令牌    | `oauth:platform:access_token` | 与 `zcodejwttoken` 写同一个值                              |
| 用户信息    | `oauth:platform:user_info`    | `{id, username(email), displayName, rawProfile}`           |
| 会话令牌    | `zcodejwttoken`               | 启动恢复的过期判定读它                                     |

约定与边界：

- **令牌格式兼容既有过期判定**：平台令牌是 `zct1.<base64url 载荷>.<签名>`，载荷含秒级 `exp`，因此既有的 `resolveJwtExpiration` 可以直接读它，不需要新的解析分支。
- **登录顺序必须是"先清厂商、再写平台"**：厂商 provider 的 `clearProvider` 会连带删除共享的 `zcodejwttoken`，反序会把刚写入的平台令牌删掉。
- **启动恢复只读本地缓存**，不做远端校验：平台暂时不可达时不能把已登录用户踢成未登录。只有令牌确实过期才进入 `reauthentication-required`。
- **登录态本身关闭登录入口**：`providerFamilyDomain` 原本是"没选厂商 family 就必须先选"的门禁。平台账号不涉及厂商 family，因此门禁改为只有未登录时才因缺少 domain 触发；已登录且 domain 为空的平台会话不会被弹回登录页。
- **失败原因直接展示**：账号密码场景下用户需要区分"凭据错"与"服务不可达"，因此登录错误不统一改写成通用文案（这一点与 OAuth 路径不同）。

## 边界

- 本期不做：自助注册、邮箱验证、密码找回、二次验证、第三方登录、多设备会话管理界面。
- 不做账号与厂商账号的绑定或迁移。平台登录成功会清除本机残留的厂商会话。
- 用户登出只清本机令牌与登录态，**不删除本机对话与项目文件**（与厂商登录时的既有行为一致）。

## 验收

1. 管理员创建用户后，该用户能登录；未创建的邮箱登录返回 `401 invalid_credentials`。
2. 密码错误返回 `401 invalid_credentials`，且响应内容与"邮箱不存在"完全相同。
3. 令牌过期后 `/api/auth/me` 返回 401，客户端回到登录界面。
4. 管理员停用用户后，该用户已登录的客户端在下一次请求时被拒。
5. 登出后本机对话列表与项目文件仍在。
6. 登录成功后 `oauth:active_provider`、`oauth:platform:user_info`、`zcodejwttoken` 三个 key 均存在，且旧厂商 key 被清除。
7. 直接写入 bcrypt 记录（`$2a$` / `$2b$` / `$2y$`）的用户能登录；登录成功后 `password_hash` 变成 `scrypt$...`，用同一密码再次登录仍成功。
8. bcrypt 记录 + 不足 8 位的旧密码：能登录，且 `password_hash` 保持 bcrypt 不变（升级不阻断登录）。
9. `$2x$` 等非法 revision、超出上限的 cost（`$2b$31$`）与任意损坏值登录返回 `401 invalid_credentials`，不出现 5xx，也不出现请求长时间挂起。
10. 密码错误的 bcrypt 记录用户登录失败，且 `password_hash` 不被改写。
