# 模型发布（管理后台）

管理员在后台按上游勾选模型、编辑每个模型的**显示名**与能力，一键生成符合客户端严格 schema 的
模型目录并推送给全部客户端。它是 [model-catalog.md](model-catalog.md) 的上层产品化：把"手写目录 JSON"
换成"结构化表单 + 服务端生成"，但下发的仍然是同一份目录、走同一个远程配置通道。

## 核心规则：显示名即客户端模型 ID

客户端的模型选择器**直接显示 modelId**（`packages/ui/src/lib/modelSelectionGroups.ts` 里
`name: modelId`），目录 schema 里没有"显示名"字段（`modelConfigDataSchema` 只有
`enabled / properties / optionSpecs`，全部严格）。因此：

1. 管理员为每个模型配置的**显示名**，就是下发到目录里的 `modelId`；客户端展示与请求都用它。
   显示名可以是中文、含空格等任意非空字符串（客户端用 `encodeURIComponent` 编码模型值，
   目录 schema 对 id 只要求非空）。
2. **上游真实模型 ID 绝不作为目录内容暴露**。它只存在平台的 `published_models` 表里，
   网关收到请求时按 `(providerId, 客户端 modelId)` 把请求体里的 `model` 字段**改写回真实 ID**
   再转发上游。目录里看不到它，客户端抓包请求也只能看到显示名。
3. 显示名在同一上游内必须唯一（网关映射按 `(providerId, displayName)` 定位，重名会歧义）；
   不同上游之间允许重名。
4. 未改写兼容：网关查不到映射时（该模型不是通过本功能发布的）按原样透传 `model`，
   计费、套餐限定的行为与过去完全一致。

### 思考参数为什么不需要生成 `map`

内置目录的 `modelConfigRules.modelApiRules` 里有按 `apiTypeMatch` 的**兜底规则**（`modelMatch: ".*"`，
覆盖 anthropic-messages / openai-chat-completions / openai-responses），思考档位到请求字段的映射
（`map`）由它们提供。平台生成的目录只写：

- `builtinProviderModelRules[].config.optionSpecs.reasoningLevel.values`（管理员勾选的档位）；
- `builtinProviderModelRules[].config.optionSpecs.maxOutputTokens.max`；
- `builtinProviderModelRules[].config.properties.*`（上下文窗口、输入格式、工具调用）。

**绝不生成 `map` 字段**：写了就是重复事实源，且表达式与内置规则不一致时行为难以推断。
管理员一个档位都不勾时不下发 `values`，客户端走内置兜底。

## 状态与所有权

| 状态                                                     | 所有者                                                                           | 说明                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 发布设置（选了哪些模型、显示名、能力、顺序、客户端协议） | `published_providers` / `published_models` 表（SQLite）                          | 唯一事实源；`PUT /api/admin/publish` 全量替换                        |
| 已下发目录（含 revision）                                | `model_catalog` 表（owner 是 catalogService）                                    | 推送时由 buildCatalog 生成后经 catalogService 校验写入，本功能不另写 |
| 上游 provider 与真实 API key                             | `gateway_providers` 表（owner 是上游管理）                                       | 本功能只读，拉模型列表时使用，key 不出服务端                         |
| 内置目录基线                                             | `config/provider/zcode-builtin.json`（镜像内 `/app/builtin/zcode-builtin.json`） | 只读基线；生成时以其为底，追加或替换 provider 层                     |

事件顺序（apply）：

```text
管理员点推送 → 读发布设置(normalize) → 读当前 revision
  → revision = max(current+1, 31)（客户端内置目录 revision 为 30，必须严格更大）
  → loadBuiltinCatalog → buildCatalog（纯函数，含与内置 provider 的重名检查）
  → catalogService.update（结构校验 + 乐观并发 expectedRevision=current）→ 写入 model_catalog
失败于任一步都不产生写入；两管理员并发推送时后者收到 conflict，重新加载后重试。
```

## 生成的目录形状

在内置目录基础上追加平台自有 provider（`keepBuiltinProviders=false` 时改为**替换**）：

```jsonc
{
  "providerId": "platform:<gatewayProviderId>", // 与内置 provider 重名直接报错
  "providerName": "<上游的显示名>",
  "config": {
    "group": "zai-family", // 内置 provider 只允许两个厂商族之一
    "builtinModelIds": ["<显示名1>", "<显示名2>"], // 顺序即客户端展示顺序
    "access": { "type": "api-key", "apiKey": "platform-gateway-managed" }, // 占位 key，真实 key 由网关注入
    "api": { "type": "<客户端协议>", "baseUrl": "<origin>/api/v1/gateway/<gatewayProviderId>" },
  },
}
```

- 客户端协议取值与客户端 `providerApiTypeDataSchema` 一致：`anthropic-messages` /
  `openai-chat-completions` / `openai-responses`（与网关上游协议 `anthropic/openai/openai-compatible`
  是两回事，分别配置）。
- `keepBuiltinProviders=false` 时：`providerRules`、`builtinProviderModelRules`、`templateRules`、
  `templateModelRules` 全部替换为平台内容；`modelRules` / `modelApiRules` / `providerSiteRules`
  **保留**——兜底映射与能力默认值来自它们，删掉会让思考档位失效。
- 目录里不含真实 API key：唯一出现的 key 是上面的固定占位符。

## 接口（均需管理员）

| 方法 | 路径                                    | 说明                                                                                                                        |
| ---- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| POST | `/api/admin/providers/:id/fetch-models` | 拉上游模型列表；openai 协议先试 `<base>/v1/models` 再退 `<base>/models`，回退成功且 base 缺 `/v1` 时返回 `suggestedBaseUrl` |
| GET  | `/api/admin/catalog/builtin`            | 内置目录摘要（provider/模型清单、能力预填、思考档位词表），供发布页展示与预填                                               |
| GET  | `/api/admin/publish`                    | 读取发布设置（未保存过时为空数组）                                                                                          |
| PUT  | `/api/admin/publish`                    | 全量保存发布设置（服务端 normalize 校验）                                                                                   |
| POST | `/api/admin/publish/preview`            | 按当前设置生成目录，返回 `revision`、摘要与完整 JSON，不写库                                                                |
| POST | `/api/admin/publish/apply`              | 生成并写入新 revision（请求体可选 `keepBuiltinProviders`，默认 true）                                                       |

失败语义：

- `fetch-models`：上游不可达或非 2xx 时报错，错误信息只含状态码，**绝不含 API key**；
  拉到的只是列表，不自动勾选、不自动保存。
- `apply`：一个模型都没选时拒绝（推空目录等于让全部客户端失去模型列表）；`origin` 未配置或非
  https 时拒绝（客户端只接受 https 目录地址）。
- 目录校验、revision 递增、并发冲突的语义与 [model-catalog.md](model-catalog.md) 完全一致。

## 数据模型（迁移 0005_model_publish）

| 表                    | 字段要点                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `published_providers` | `provider_id`（= gateway_providers.id）、`client_protocol`（三选一 CHECK）、审计字段                                                                                                                                                                          |
| `published_models`    | 主键 `(provider_id, upstream_model_id)`；`display_name` 唯一索引（同上游内）；`position` 决定顺序；能力列 `context_window / supports_image / supports_pdf / supports_video / supports_audio / supports_tool_call / reasoning_levels_json / max_output_tokens` |

## 验收

1. 后台勾选模型并填写显示名，保存后 apply，`GET /api/v1/client/configs` 指向的目录 JSON：
   `builtinModelIds` 与 `builtinProviderModelRules` 都只含显示名，按页面顺序排列；不含上游真实
   模型 ID 与真实 API key；客户端解码器 `decodeZCodeBuiltinRelease` 能整份通过。
2. 客户端用显示名请求网关，上游收到的 `model` 是真实 ID；用量与单价按真实 ID 记账。
3. 同一设置重复 apply，revision 递增且每版都能按 revision 取回。
4. 保留/不保留内置 provider 两种模式生成的目录都能通过客户端解码器；
   不保留时客户端仍能获得思考档位（modelApiRules 兜底仍在）。
5. 显示名重名（同上游内）保存被拒；非法协议、非法思考档位、非正整数窗口被拒。
