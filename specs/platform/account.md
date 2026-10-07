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

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 入参 `{email, password}`；成功返回 `{token, expiresAt, user}` |
| POST | `/api/auth/logout` | 客户端登出，令牌加入撤销列表 |
| GET | `/api/auth/me` | 校验令牌并返回当前用户与角色 |
| POST | `/api/auth/password` | 修改自己的密码（需原密码） |
| POST | `/api/admin/users` | 管理员创建用户（邮箱、密码、角色、初始余额） |
| POST | `/api/admin/users/:id/password` | 管理员重置密码 |
| PATCH | `/api/admin/users/:id` | 管理员改角色或停用 |

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

| 数据 | 存放位置 | 备注 |
| --- | --- | --- |
| 邮箱、密码哈希、角色、状态 | 平台数据库 `users` | 密码只存 scrypt 派生值 |
| 登录会话 | 平台数据库 `sessions` | 支持撤销、有过期时间 |
| 令牌 | 客户端 credential（AES-256-GCM，既有机制） | 明文只在进程内存 |

密码哈希：`node:crypto` 的 `scrypt`，每个用户独立随机 salt，参数固定写入记录（`N=16384, r=8, p=1, keylen=64`），校验用 `timingSafeEqual`。

令牌：HMAC-SHA256 签名的紧凑令牌，载荷含 `userId`、`role`、`sessionId`、`exp`。签名密钥来自服务端环境变量，缺失时服务端拒绝启动（不允许用默认值兜底）。

## 客户端实现

平台登录**不是 OAuth**：凭据由表单提交给 host，host 直接向平台换取会话。不打开浏览器，没有 deep link 回调。

| 项 | 取值 | 说明 |
| --- | --- | --- |
| provider id | `platform` | 出现在 provider 体系里，只为复用凭据命名空间与启动恢复链路 |
| 访问令牌 | `oauth:platform:access_token` | 与 `zcodejwttoken` 写同一个值 |
| 用户信息 | `oauth:platform:user_info` | `{id, username(email), displayName, rawProfile}` |
| 会话令牌 | `zcodejwttoken` | 启动恢复的过期判定读它 |

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
