# 平台服务部署

平台服务是 RCode 商业版的唯一服务端：账号、模型网关、计费、管理后台与客户端发布都在一个进程里。
它持有上游 API key 与全部用户余额，因此所有默认值都偏保守（监听回环、密钥缺失即拒绝启动）。

## 一、准备

需要 Docker 与 Docker Compose v2。先准备两个值：

| 变量 | 用途 | 怎么生成 |
| --- | --- | --- |
| `ZCODE_PLATFORM_TOKEN_SECRET` | 会话令牌签名密钥。泄露即可伪造任意用户登录 | `openssl rand -hex 32` |
| `ZCODE_PLATFORM_PUBLIC_ORIGIN` | 对外站点地址，客户端据此拉取模型目录与更新 | 形如 `https://zcode.example.com` |

在 `deploy/` 下建 `.env`：

```bash
cat > deploy/.env <<'EOF'
ZCODE_PLATFORM_TOKEN_SECRET=<粘贴 openssl rand -hex 32 的输出>
ZCODE_PLATFORM_PUBLIC_ORIGIN=https://zcode.example.com
EOF
chmod 600 deploy/.env
```

## 二、启动

只起平台（自己接反向代理，或先在本机试用）：

```bash
cd deploy
docker compose up -d --build
```

连同 Caddy 一起起，自动申请 TLS 证书（域名需已解析到本机，80/443 可达）：

```bash
cd deploy
ZCODE_PLATFORM_DOMAIN=zcode.example.com docker compose --profile tls up -d --build
```

## 三、创建首个管理员

平台不开放自助注册，第一个管理员只能在服务器上创建：

```bash
docker compose exec platform node dist/adapters/entry.js create-admin you@example.com '至少8位的密码'
```

之后在 `https://<你的域名>/`（或 `http://127.0.0.1:3100/`）登录管理后台，后续账号都在后台创建。

## 四、把客户端指向平台

客户端在**构建时**把平台地址烘进产物，运行期改不了：

```bash
cd ..
ZCODE_BASE_URL=https://zcode.example.com pnpm bundle:desktop -- --os win --arch x64
ZCODE_BASE_URL=https://zcode.example.com pnpm bundle:desktop -- --os mac --arch arm64
```

## 五、上线前的必要配置

1. **配上游**：后台「上游」页新建 provider，填上游 baseUrl 与 API key。key 只写不读，列表只显示末四位。
2. **导模型目录**：客户端对目录的 schema 是严格的，**不要手写**——用仓库脚本生成，
   它会用客户端自己的解码器校验产物：

   ```bash
   # 把内置目录里指定的 provider 改指向平台网关（这一步决定客户端会不会走网关计费）
   tsx scripts/build-platform-catalog.mjs \
     --origin https://<你的域名> --rewrite <providerId> --out build/catalog.json

   # 追加平台自有的上游（片段格式见脚本头部注释）
   tsx scripts/build-platform-catalog.mjs \
     --origin https://<你的域名> --add deploy/provider-snippet.json --out build/catalog.json
   ```

   然后把 `build/catalog.json` 的内容贴进后台「模型目录」页保存。生成时注意：
   `revision` 必须大于客户端内置目录的版本（当前 30），否则客户端会当成过期丢弃；
   平台自有的 provider 必须挂在 `zai-family` 或 `bigmodel-family` 下；模型列表要写进 `config.builtinModelIds`。
   细节见 [specs/platform/model-catalog.md](../specs/platform/model-catalog.md)。
3. **配单价**：后台「单价」页按模型配置输入/输出/缓存价格（每百万 token）。没配单价的模型按 0 计费。
4. **建用户并充值**：后台「用户」页建号，进详情页充值。
5. **发布客户端**：后台「客户端发布」页上传安装包，平台自动计算 sha512 并生成更新清单。

## 六、数据与备份

| 路径 | 内容 |
| --- | --- |
| `/data/platform.sqlite` | 用户、会话、余额、流水、用量、目录、套餐、发布登记 |
| `/data/releases/<版本>/` | 上传的客户端安装包 |

两者都在 `platform-data` 卷里。备份：

```bash
docker run --rm -v deploy_platform-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/platform-backup.tar.gz -C /data .
```

余额的正确性可以从流水重算：后台用户详情页的「对账」按钮会比对余额与流水合计，差异应为 0。

## 七、已知限制

- **未签名安装包无法自动更新**。macOS 的 Squirrel 会拒绝未公证的应用，Windows 会被 SmartScreen 拦截。
  证书到位前请手动分发安装包（后台仍会正常生成更新清单，客户端能检测到新版本）。
- **平台是单实例服务**。SQLite 支持并发读写，但不要同时起多个平台容器指向同一个数据卷。
- **管理后台没有多角色细分**：所有 admin 权限相同，没有审计日志。对外开放前请确保只有可信人员能访问后台。
