# 模型目录下发

管理员在后台配置的模型/供应商目录，通过仓库已有的远程配置通道下发给所有客户端，**不需要发新版本**。

> 后台推荐入口是"模型发布"页（结构化表单，见 [model-publish.md](model-publish.md)）；
> 本文描述的是它底层的目录机制与"模型目录"页直接编辑 JSON 的约束。

## 复用的现有机制

客户端已经实现了完整的"远程目录刷新"能力，本方案不新造通道：

1. 客户端 `GET <origin>/api/v1/client/configs?app_version=&platform=`
2. 响应里 `data.configs.builtin_provider_config_json` 是一个 https URL
3. 客户端下载该 URL 的 JSON，按 `decodeRCodeBuiltinRelease` 严格校验
4. `revision` 必须**严格大于**当前值才生效；相同 revision 但内容不同会抛错
5. 生效后写入 active 缓存，agent 侧的文件监听触发 provider registry 重新解析，**无需重启**

平台只要实现第 1 步并托管第 2 步指向的 JSON 即可。

## 产品规则

- 平台是目录的**唯一所有者**，客户端只读。
- 管理员的每次修改都必须把 `revision` 递增，否则客户端不会应用。
- `schemaVersion` 固定为 `1`。
- 目录里所有平台管理的 provider，`api.baseUrl` 一律指向 `<platformOrigin>/api/v1/gateway/<providerId>`，使模型流量必经网关。
- **上游 API key 绝不写入目录**。目录是全站共享的同一个 JSON，任何人可下载，写进去等于公开密钥。

## 约束

- 客户端用 `.strict()` 解析目录，**未知字段会被拒绝**。因此给目录增字段等于要求客户端先升级；本期只使用客户端已支持的既有字段。
- 下发有延迟：客户端每 60 秒检查一次，成功后有 1 小时 TTL，失败按指数退避。管理员改完目录到所有客户端生效，最长约 1 小时，不是实时的。
- 目录被拒或下载失败时客户端保留上一次的 active 缓存，最差回退到随包内置的目录。

## 与客户端 schema 的硬约束（实机联调确认）

以下几条是接真实客户端时踩到的，违反任意一条都会被客户端拒绝或静默不生效：

1. **内容必须嵌在 `config` 下**：`{ schemaVersion: 1, revision, config: { providerConfigRules, modelConfigRules } }`。
   把 `providerConfigRules` 放顶层会被判为 `invalid schema at config`；`config` 是严格对象，只允许这两个键。
2. **`revision` 必须大于客户端当前持有的值**。客户端内置目录的 revision 是 30，且会在内置与远程之间取较大者；
   平台首次下发必须 **> 30**，否则客户端视为过期直接丢弃（`scripts/build-platform-catalog.mjs` 默认在源目录基础上 +1）。
3. **内置 provider 的 `group` 只能是 `zai-family` 或 `bigmodel-family`**：客户端 schema 明确排除了
   `standard-personal`（`packages/provider/src/config/rule-data-schema.ts`）。平台自有的上游因此也必须挂到某个厂商族下，
   这会影响模型在界面上的分组可见性。
4. **provider 的模型列表要写在 `config.builtinModelIds`**。只加 `builtinProviderModelRules` 不会让模型出现在界面上——
   那是规则层，不是可见清单。
5. **`/api/v1/client/configs` 的信封必须是 `{ code: 0, data: { configs: { ... } } }`**，且
   `builtin_provider_config_json` 必须是 **https 且不带凭据**的地址：http 地址会被客户端直接拒绝
   （`packages/provider-node/src/zcode-builtin-download.ts` 里的 refine）。**所以生产部署必须用 https 域名**，
   反向代理终止 TLS 即可；本地 http 联调时平台会明确报错而不是推一份客户端无法使用的目录。

不要手写目录：用 `scripts/build-platform-catalog.mjs` 生成，它会用**客户端自己的解码器**
（`decodeZCodeBuiltinRelease`）校验产物，不通过就直接失败。

```bash
# 把内置目录里指定的 provider 改指向平台网关
tsx scripts/build-platform-catalog.mjs --origin https://你的域名 --rewrite <providerId> --out build/catalog.json

# 追加平台自有上游（provider 片段格式见脚本头部注释）
tsx scripts/build-platform-catalog.mjs --origin https://你的域名 --add deploy/provider-snippet.json --out build/catalog.json
```

## 客户端侧的可覆盖性（已知取舍）

provider 配置的优先级是 `内置目录 ⊕ 平台/账号覆盖 ⊕ 模板 ⊕ 用户个人覆盖`，**用户个人配置优先级最高**。因此用户可以在设置里改掉某个内置 provider 的 `api.baseUrl`。

这不是漏洞：网关令牌只在目标 origin 等于平台网关时注入（见 [gateway-billing.md](gateway-billing.md)），用户改掉地址后请求不会带上令牌，也不会拿到上游 key，结果是该 provider 对他自己不可用。计费与授权的完整性不依赖客户端配置不可改。

## 数据模型

平台数据库保存目录 JSON 与其 revision：

| 字段 | 说明 |
| --- | --- |
| `revision` | 单调递增整数，管理员每次保存 +1 |
| `content` | 目录 JSON 全文 |
| `updated_at` / `updated_by` | 审计信息 |

初始化方式：以仓库内的 `config/provider/zcode-builtin.json` 为起点导入，并把各 provider 的 `api.baseUrl` 改写为网关地址。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/client/configs` | 客户端拉取入口，返回 `builtin_provider_config_json` 指向下方 URL |
| GET | `/api/v1/catalog/<revision>.json` | 目录全文（按 revision 固定 URL，便于客户端缓存与排查） |
| GET | `/api/admin/catalog` | 管理员读取当前目录 |
| PUT | `/api/admin/catalog` | 管理员保存目录，服务端校验 schema 后 revision +1 |

服务端保存时必须先跑一遍与客户端同源的校验（schemaVersion、revision 递增、provider 结构），拒绝非法目录，避免把不可解析的目录推给全部客户端。

## 验收

1. 管理员修改目录后，运行中的客户端在 1 小时内（实际约 60 秒）看到新的模型列表，且没有重启。
2. 保存 revision 未递增的目录被服务端拒绝。
3. 保存结构非法的目录被服务端拒绝，且客户端上原有目录不受影响。
4. 目录里任何 provider 都不含明文 API key。
5. 客户端把某个内置 provider 的 baseUrl 改成本机地址后，该 provider 调用失败且不携带网关令牌。
