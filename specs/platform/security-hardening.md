# 平台安全加固（审计 B1–B8）

来源：平台安全审计。本文覆盖审计 #10、#11、#12、#17、#18、#19 六条，以及两项无审计编号的加固（sessions 清理、请求体上限）。
本文只描述平台服务端（`packages/platform`）；审计 #5"无审计日志"已由 `specs/platform/operations.md` 覆盖，不在此重复。

## B1 登录限流（审计#10）

背景：`POST /api/auth/login` 原本没有频率限制，管理员密码可被无限次尝试。

规则：

- 计数键 = 客户端 IP + 归一化邮箱（`trim().toLowerCase()`），两者任一不同即独立计数。
- 客户端 IP 取值顺序：`X-Forwarded-For` 第一段（反向代理部署时由代理写入）→ `X-Real-IP` → 连接 socket 的 `remoteAddress` → `"unknown"`。服务默认只监听回环地址（`config.ts`），公网流量必须经过反向代理。
- 滑动窗口 15 分钟；窗口内失败达到 5 次后进入锁定：锁定毫秒数 = `min(2^(n-5) 秒, 15 分钟)`，n 为窗口内累计失败次数（第 5 次失败本身仍返回 401，同时开启 1 秒锁）。
- 锁定期间一律返回 `429`，错误码 `too_many_requests`，附 `Retry-After` 秒数；**不校验凭据**，不增加计数。
- 登录成功立即清除该键的失败记录（"成功登录清零"）。
- 只有 `invalid_credentials` 计入失败；请求体非法（400）不计入，避免构造畸形请求刷锁。
- 失败记录存进程内存 `Map`（进程重启清零，可接受）；条目数超过上限时先清理窗口外条目，防止用海量邮箱撑爆内存。
- 参数为 `auth.ts` 模块内常量（窗口、阈值、2^n 基准、锁上限、条目上限）。

部署层结论：本仓库没有 nginx 配置。反向代理是 `deploy/Caddyfile`（Caddy），其核心发行版没有内置的 `rate_limit` 指令（需第三方插件），因此限流在应用层实现；`deploy/` 不在本次改动范围。

## B2 管理员自我保护（审计#11）

背景：`PATCH /api/admin/users/:id` 允许管理员停用自己、或把最后一个启用的管理员降级/停用，导致系统失去管理入口。

规则（在 `PATCH` 内校验，作用于生效值 `nextRole = body.role ?? target.role`、`nextStatus = body.status ?? target.status`）：

| 场景                                                         | 结果                                         |
| ------------------------------------------------------------ | -------------------------------------------- |
| 目标是自己且 `nextStatus !== "active"`                       | `403 forbidden`（不能停用自己）              |
| 目标是自己且 `nextRole !== "admin"`                          | `403 forbidden`（不能降级自己）              |
| 目标是当前唯一启用的管理员，且操作会使其不再是"启用的管理员" | `409 conflict`（必须保留至少一个启用管理员） |
| 无实际变化（如把自己设为当前值）                             | 放行，按幂等处理                             |

- "启用的管理员"= `role = 'admin' AND status = 'active'`；计数走 `UserRepository.countActiveWithRole("admin")`（SQL COUNT），不靠分页列表推断。
- 自保护比 `account.md` 中"还有其他管理员时允许自我停用/降级"更严格（一律禁止自我停用/降级）。`account.md` 的对应表述以本文为准，需在后续更新中同步（该文件不在本次改动范围）。
- 唯一启用管理员检查是纵深防御：正常情况下操作者本身是启用的管理员，跨管理员操作不会触发；它挡住并发交错等极端路径。

## B3 管理后台安全响应头（审计#12）

背景：console 静态资源没有任何安全响应头。

规则：只对 console 静态资源（`/` 与 `/console/*`）的响应追加：

| 头                        | 值                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `X-Frame-Options`         | `DENY`                                                                                                                                                                              |
| `Referrer-Policy`         | `no-referrer`                                                                                                                                                                       |
| `X-Content-Type-Options`  | `nosniff`                                                                                                                                                                           |

收紧依据（已核对 console 源码）：`console/index.html` 只有一条外部 module script（`/console/app.js`）和一条外部样式表，没有内联 `<script>`/`<style>`/`style=` 属性；各 `screens-*.js` 只做 `onclick` 属性赋值（CSP 不拦），没有 `eval`/`new Function`；没有外链资源。`index.html` 自带的 meta CSP 与上述值一致，因此不需要为内联放宽（不放 `unsafe-inline`）。`img-src 'self' data:` 保留 `data:` 与既有 meta 一致。
API 响应不带这些头（CSP 只对文档生效）。

## B4 发布产物下载：Range 与登记校验（审计#17）

背景：`GET /releases/electron/:version/:fileName` 直接按路径读盘，既不支持 Range（更新器断点续传/分段下载），也不校验文件是否登记在发布记录中。

规则：

- 名称边界：`version` 与 `fileName` 只允许 `[0-9A-Za-z._-]` 且不是 `.`/`..`（挡路径分隔符与目录遍历）；不合法直接按 `404` 处理，不给探测者语法反馈。
- 登记校验：必须能在发布记录中找到 `(version, fileName)`（`releaseService.findReleaseFile`），未登记一律 `404`（即使文件恰好躺在磁盘上）。
- 响应始终带 `Accept-Ranges: bytes`。
- `Range` 支持（单段）：
  - 无 Range → `200` + `Content-Length`，完整文件。
  - `bytes=start-end` / `bytes=start-` → `206` + `Content-Range: bytes start-end/size` + 对应 `Content-Length`；end 超过文件大小按 `size-1` 截断。
  - `bytes=-N` 后缀：N 为 0 视为不可满足；N 大于等于文件大小时返回 `206` 覆盖全文件（`0-(size-1)`）。
  - start 大于等于文件大小、start > end、数字非法 → `416` + `Content-Range: bytes */size`（不读文件）。
  - 非 `bytes` 单位或多段 Range（含逗号）→ 按 RFC 7233 允许的方式忽略，返回 `200` 完整文件。

## B5 产物上传原子化（审计#18）

背景：上传直接写最终路径，写入中断会留下半截文件；Windows 下 `rename` 覆盖已存在目标会失败。

流程（`PUT /api/admin/releases/:version/:fileName`）：

1. 同一个版本目录下先写临时文件 `.tmp-<fileName>-<随机十六进制>`（`fileName` 已通过名称边界校验，不含路径分隔符）。
2. 边写边计数/算 sha512；写完后 `stat` 校验临时文件确实是常规文件、且落盘大小等于写入计数、大小大于 0。
3. `rename` 到最终名；Windows 上目标已存在时 rename 返回 `EPERM/EACCES/EEXIST`，此时先删旧目标再 rename（旧产物本来就会被新上传取代；允许极短的"目标缺失"窗口，但绝不会出现半写文件）。
4. 任一步失败：删除临时文件并原样抛错；rename 成功前旧文件不动，因此失败不会破坏已登记产物。
5. 数据库登记（`releaseService.upsert`）在文件落位后执行；登记失败时文件未登记，下载侧（B4）会拒绝它。

上传不受 B8 的 API 32MB 上限约束：安装包可达数百 MB（`deploy/Caddyfile` 已把请求体上限放宽到 2GB），该路由流式写盘并自行计数。

## B6 版本比较（审计#19）

背景：原 `compareVersions` 把 `-`/`+` 后的段当成整数丢掉，导致 `1.0.0-beta` 与 `1.0.0` 判等、预发布通道可能把 beta 当正式版。

规则（标准 semver 优先级，`src/domain/releases.ts` 纯函数）：

- 忽略前导 `v` 与构建元数据（`+` 之后）。
- 主版本段逐段数值比较，缺失段视为 0。
- 有预发布段 < 无预发布段：`1.0.0-beta < 1.0.0`。
- 同为预发布：逐段比较标识符；纯数字段按数值（去前导零后先比长度、再字典序，避免大数精度问题）；数字标识恒低于非数字标识；非数字标识按 ASCII 字典序；所有已比较段相同则段数少者更低（`1.0.0-alpha < 1.0.0-alpha.1`）。
- `pickLatestRelease` 语义不变：同平台同通道取版本最高者，正式版胜过同号预发布版；版本相同保留先出现者。

## B7 sessions 过期清理

背景：`deleteExpiredBefore` 仓储方法已存在（基线），但没人调用，`sessions` 表无限增长。

规则：装配点（`composition.ts`）在运行时创建时清一次（`expires_at < now()`），之后每小时清一次；定时器 `unref()`，不阻止进程退出；`dispose()` 清除定时器。清理失败只记 `warn`，不影响启动或服务。过期判定沿用表结构：`expires_at < now`（被撤销但未过期的会话保留，因为它们仍然占位且终将过期）。

## B8 API 请求体上限

背景：API 请求体没有大小限制；而上传路由又刻意允许大文件。

规则：`/api/*` 默认上限 32MB（`app.ts` 模块常量 `DEFAULT_MAX_API_BODY_BYTES`，可在 `createPlatformApp` 传 `maxBodyBytes` 覆盖，测试用）：

- 有 `Content-Length` 且超过上限 → 立即 `413`，错误码 `payload_too_large`，不读请求体。
- 无 `Content-Length`（chunked）→ 流式读取并计数，超过上限立即 `413`（下游拿不到被截断的 body）。
- 例外：`PUT /api/admin/releases/*`（见 B5）。
- 只检查请求体，不缓冲、不影响响应，因此 SSE 流式输出不受影响。
- `413 payload_too_large` 与 `429 too_many_requests` 是本次新增的**边界错误码**（`domain/errors.ts` 的 `PLATFORM_ERROR_CODES` 未扩展，该文件不在本次改动范围；后续收敛时应补入）。

## 验收场景

1. 同一 IP+邮箱连续 4 次密码错误均 401；第 5 次 401 并进入锁定；第 6 次（即使密码正确）429 + `Retry-After`；换 IP 不受影响；中途成功登录后失败计数清零。
2. 管理员 PATCH 自己 `status=disabled` 或 `role=user` → 403；把当前唯一启用管理员降级/停用（单元层面）→ 409；降级另一个管理员、停用普通用户仍正常。
3. console 页面与静态资源带 CSP/X-Frame-Options/Referrer-Policy；API 响应不带。
4. 已登记产物的 `Range: bytes=2-5` → 206 且内容与 `Content-Range` 正确；超界/非法 Range → 416；磁盘上有文件但未登记 → 404；路径穿越 → 非 200。
5. 上传成功后目录内没有 `.tmp-*` 残留；空内容上传失败后不留下任何半截文件；重复上传同名产物内容被原子替换。
6. `1.0.0-beta < 1.0.0`、`1.0.0-rc.1 < 1.0.0-rc.2`、`1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta`、构建元数据不影响比较；`pickLatestRelease` 在 `1.0.0-rc.1` 与 `1.0.0` 中取 `1.0.0`。
7. 启动时清理过期会话（过期记录消失、未过期记录保留），定时器不阻止进程退出。
8. 超过上限的请求返回 413，未超限请求行为不变。
