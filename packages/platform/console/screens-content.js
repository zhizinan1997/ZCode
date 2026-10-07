/** 管理后台：概览、模型目录、上游、单价、套餐、客户端发布。 */
import {
  api,
  el,
  esc,
  field,
  fmtBytes,
  fmtMicros,
  fmtTime,
  getToken,
  metric,
  showMessage,
  showModal,
  state,
  toast,
} from "./api.js";
// 页面注册走 app.js 的 registerScreen；queueMicrotask 等其 SCREENS 初始化完成（见 screens-users.js 头注释）。
import { registerScreen } from "./app.js";

// ── 上游 provider 页 ─────────────────────────────────────────
// 引用计数缓存：providers 与 prices 页各自拉一次 catalog，避免每次渲染重复请求。
let catalogReferenceCounts = null;

/** 从目录 JSON 统计每个上游被 builtinProviderModelRules 引用的模型数；拉不到返回空表。 */
function loadCatalogReferenceCounts() {
  return api("/api/admin/catalog")
    .then((body) => {
      const counts = {};
      try {
        const content = JSON.parse(body.content || "{}");
        const config = content.config || {};
        const modelRules = (config.modelConfigRules || {}).builtinProviderModelRules || [];
        for (const rule of modelRules) {
          if (rule && typeof rule.providerId === "string") {
            counts[rule.providerId] = (counts[rule.providerId] || 0) + 1;
          }
        }
      } catch {
        // 目录内容缺省或不是合法 JSON 时按无引用处理，不阻塞列表渲染。
      }
      catalogReferenceCounts = counts;
      return counts;
    })
    .catch(() => {
      // catalog 拉不到（含 404/401 之外的异常）就按无引用统计，删除按钮不带引用警告。
      catalogReferenceCounts = {};
      return {};
    });
}

function providerReferenceCount(providerId) {
  if (!catalogReferenceCounts) return 0;
  // 发布流水线给平台上游加 "platform:" 前缀（见 src/domain/modelPublish.ts），两种形态都算。
  return (
    (catalogReferenceCounts[providerId] || 0) +
    (catalogReferenceCounts["platform:" + providerId] || 0)
  );
}

function resetProviderForm() {
  el("provider-form-mode").value = "create";
  el("provider-id").value = "";
  el("provider-id").disabled = false;
  el("provider-label").value = "";
  el("provider-url").value = "";
  el("provider-protocol").value = "anthropic";
  el("provider-key").value = "";
  el("provider-enabled").checked = true;
  showMessage("provider-message", "");
}

/** 编辑按钮经 app.js 全局委托 dispatch 自定义事件，这里把该上游载入表单。 */
function loadProviderIntoForm(id) {
  // 事件是 document 级的：表单不存在（不在上游页）时静默忽略。
  if (!el("provider-form-mode")) return;
  const provider = state.providers.find((item) => item.id === id);
  if (!provider) return;
  el("provider-form-mode").value = "edit";
  el("provider-id").value = provider.id;
  el("provider-id").disabled = true;
  el("provider-label").value = provider.label || "";
  el("provider-url").value = provider.upstreamBaseUrl || "";
  el("provider-protocol").value = provider.protocol || "anthropic";
  el("provider-key").value = "";
  el("provider-enabled").checked = Boolean(provider.enabled);
  syncProviderUrlHint();
  el("provider-label").focus();
}

document.addEventListener("screen:providers", (e) => loadProviderIntoForm(e.detail.edit));

/** openai 系协议且 baseUrl 缺少 /v1 时给出黄色提示（仅提示，不拦截保存）。 */
function syncProviderUrlHint() {
  const protocol = el("provider-protocol").value;
  const url = el("provider-url").value.trim();
  const needsV1 = protocol === "openai" || protocol === "openai-compatible";
  if (needsV1 && url && !url.endsWith("/v1")) {
    showMessage("provider-url-hint", "openai 系上游 baseUrl 通常以 /v1 结尾（当前值缺少）", "warn");
  } else {
    showMessage("provider-url-hint", "");
  }
}

export function renderProviders() {
  return Promise.all([api("/api/admin/providers"), loadCatalogReferenceCounts()]).then(
    (results) => {
      state.providers = results[0].providers;
      const rows = state.providers
        .map((provider) => {
          const references = providerReferenceCount(provider.id);
          // 0 引用时必须传空串：app.js 用 truthy 判断是否显示引用警告，"0" 会被误判。
          const referencesAttr = references > 0 ? ' data-references="' + references + '"' : "";
          return (
            "<tr><td>" +
            esc(provider.id) +
            "</td><td>" +
            esc(provider.label) +
            "</td><td>" +
            esc(provider.upstreamBaseUrl) +
            "</td><td>" +
            esc(provider.protocol) +
            "</td><td>" +
            '<span class="badge ' +
            (provider.enabled ? "ok" : "danger") +
            '">' +
            (provider.enabled ? "启用" : "停用") +
            "</span></td><td>" +
            esc(provider.apiKeyHint) +
            '</td><td class="actions">' +
            '<button class="btn small" data-action="edit-provider" data-id="' +
            esc(provider.id) +
            '">编辑</button>' +
            '<button class="btn small" data-action="test-provider" data-id="' +
            esc(provider.id) +
            '">测试连接</button>' +
            '<button class="btn small" data-self-action="fetch-models" data-id="' +
            esc(provider.id) +
            '">拉取模型</button>' +
            '<button class="btn small danger" data-action="delete-provider" data-id="' +
            esc(provider.id) +
            '"' +
            referencesAttr +
            ">删除</button></td></tr>"
          );
        })
        .join("");

      el("panel").innerHTML =
        '<section class="section"><h2>上游 provider</h2>' +
        '<p class="muted">客户端把平台管理的模型指向 <code>/api/v1/gateway/&lt;id&gt;</code>，' +
        "网关按这里的配置转发到真实上游，并注入这里的 API key。" +
        "key 只写不读：列表里只显示末四位。</p>" +
        '<div class="row">' +
        '<input type="hidden" id="provider-form-mode" value="create" />' +
        field("provider-id", "id（客户端目录里引用它，保存后不可改）", "text") +
        field("provider-label", "显示名", "text") +
        '<div class="field"><label for="provider-url">上游 baseUrl</label>' +
        '<input id="provider-url" type="text" placeholder="https://api.anthropic.com" /></div>' +
        '<div class="field"><label for="provider-protocol">协议</label><select id="provider-protocol">' +
        '<option value="anthropic">anthropic</option><option value="openai">openai</option>' +
        '<option value="openai-compatible">openai-compatible</option></select></div>' +
        field("provider-key", "API key（编辑时留空表示不改）", "password") +
        '<div class="field"><label for="provider-enabled">状态</label>' +
        '<label class="check"><input id="provider-enabled" type="checkbox" checked /> 启用该上游</label></div>' +
        '<button class="btn primary" id="save-provider">保存</button>' +
        "</div>" +
        '<div id="provider-url-hint" class="message"></div>' +
        '<p class="muted">openai 系上游通常需要以 /v1 结尾。</p>' +
        '<div id="provider-message" class="message"></div></section>' +
        '<section class="section"><h2>已有上游</h2>' +
        (state.providers.length === 0
          ? '<span class="muted">还没有配置上游。客户端目录指向网关但没有上游时，模型调用会返回 404。</span>'
          : '<div class="table-scroll"><table><thead><tr><th>id</th><th>显示名</th><th>baseUrl</th><th>协议</th><th>状态</th><th>key</th><th>操作</th></tr></thead><tbody>' +
            rows +
            "</tbody></table></div>") +
        "</section>";

      resetProviderForm();
      el("provider-protocol").onchange = syncProviderUrlHint;
      el("provider-url").addEventListener("input", syncProviderUrlHint);
      syncProviderUrlHint();

      el("save-provider").onclick = () => {
        const mode = el("provider-form-mode").value;
        const id = el("provider-id").value.trim();
        if (!id) {
          showMessage("provider-message", "id 不能为空", "error");
          return;
        }
        if (mode === "edit" && !state.providers.some((item) => item.id === id)) {
          showMessage("provider-message", "该上游已不存在，请刷新后重试", "error");
          return;
        }
        api("/api/admin/providers/" + encodeURIComponent(id), {
          method: "PUT",
          body: JSON.stringify({
            label: el("provider-label").value,
            upstreamBaseUrl: el("provider-url").value.trim(),
            protocol: el("provider-protocol").value,
            // apiKey 留空 = 不改（后端 readOrKeep）；新建时后端要求非空。
            apiKey: el("provider-key").value,
            enabled: el("provider-enabled").checked,
          }),
        })
          .then(() => {
            showMessage("provider-message", "已保存", "ok");
            renderProviders();
          })
          .catch((error) => showMessage("provider-message", error.message, "error"));
      };

      // "拉取模型"是本页私有动作（app.js 只认 data-action），自己绑定 click。
      for (const button of el("panel").querySelectorAll("[data-self-action='fetch-models']")) {
        button.onclick = () => {
          const providerId = button.dataset.id;
          toast("拉取模型列表中…");
          api("/api/admin/providers/" + encodeURIComponent(providerId) + "/fetch-models", {
            method: "POST",
          })
            .then((body) => {
              const models = body.models || [];
              toast("拉到 " + models.length + " 个模型");
              if (body.suggestedBaseUrl) {
                toast("建议把该上游 baseUrl 改成 " + body.suggestedBaseUrl, true);
              }
              const modalClosed = showModal({
                title: providerId + " 的模型列表",
                text:
                  "共 " +
                  models.length +
                  " 个模型" +
                  (body.suggestedBaseUrl
                    ? "；建议把上游 baseUrl 改成 " + body.suggestedBaseUrl
                    : ""),
                fields:
                  models.length === 0
                    ? []
                    : [
                        {
                          id: "models",
                          label: "前 20 个模型（可复制）",
                          type: "text",
                          value: models.slice(0, 20).join(", "),
                        },
                      ],
                okLabel: "关闭",
              });
              // showModal 同步构建 DOM；弹层在 #panel 外，copy-text 的全局委托收不到，
              // 这里自己注入"复制"按钮。
              const fieldsBox = el("modal-fields");
              const input = fieldsBox ? fieldsBox.querySelector("input") : null;
              if (fieldsBox && input) {
                const copy = document.createElement("button");
                copy.type = "button";
                copy.className = "btn small";
                copy.dataset.action = "copy-text";
                copy.textContent = "复制";
                copy.addEventListener("click", () => {
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(input.value).then(
                      () => toast("已复制"),
                      () => toast("复制失败", true),
                    );
                  } else {
                    toast("浏览器不支持复制", true);
                  }
                });
                fieldsBox.appendChild(copy);
              }
              return modalClosed.then(() => null);
            })
            .catch((error) => toast(error.message, true));
        };
      }
    },
  );
}

// ── 单价页 ───────────────────────────────────────────────────
/** 新建时四价必须非空；编辑时留空 = 保留现值（后端 readOrKeep 逻辑）。 */
function priceLabelSuffix(mode) {
  return mode === "edit" ? "（留空 = 不改）" : "";
}

function resetPriceForm() {
  el("price-form-mode").value = "create";
  el("price-model").value = "";
  el("price-model").disabled = false;
  el("price-input").value = "";
  el("price-output").value = "";
  el("price-cache-read").value = "";
  el("price-cache-write").value = "";
  for (const id of ["price-input", "price-output", "price-cache-read", "price-cache-write"]) {
    el(id).required = true;
  }
  for (const id of [
    "price-input-label-suffix",
    "price-output-label-suffix",
    "price-cache-read-label-suffix",
    "price-cache-write-label-suffix",
  ]) {
    el(id).textContent = "";
  }
  showMessage("price-message", "");
}

/** 编辑按钮经 app.js 全局委托 dispatch 自定义事件，这里把现有四价填进表单。 */
function loadPriceIntoForm(modelId) {
  // 事件是 document 级的：表单不存在（不在单价页）时静默忽略。
  if (!el("price-form-mode")) return;
  const price = state.priceRows ? state.priceRows.find((item) => item.modelId === modelId) : null;
  if (!price) return;
  el("price-form-mode").value = "edit";
  el("price-model").value = price.modelId;
  el("price-model").disabled = true;
  el("price-input").value =
    price.input === null || price.input === undefined ? "" : String(price.input);
  el("price-output").value =
    price.output === null || price.output === undefined ? "" : String(price.output);
  el("price-cache-read").value =
    price.cacheRead === null || price.cacheRead === undefined ? "" : String(price.cacheRead);
  el("price-cache-write").value =
    price.cacheWrite === null || price.cacheWrite === undefined ? "" : String(price.cacheWrite);
  for (const id of ["price-input", "price-output", "price-cache-read", "price-cache-write"]) {
    el(id).required = false;
  }
  for (const id of [
    "price-input-label-suffix",
    "price-output-label-suffix",
    "price-cache-read-label-suffix",
    "price-cache-write-label-suffix",
  ]) {
    el(id).textContent = priceLabelSuffix("edit");
  }
  el("price-input").focus();
}

document.addEventListener("screen:prices", (e) => loadPriceIntoForm(e.detail.edit));

/** "一键补价"：把未配价模型 id 载入表单并聚焦输入价。 */
function prefillPriceForm(modelId) {
  const existing = state.priceRows
    ? state.priceRows.find((item) => item.modelId === modelId)
    : null;
  if (existing) {
    loadPriceIntoForm(modelId);
    return;
  }
  resetPriceForm();
  el("price-model").value = modelId;
  el("price-input").focus();
}

/**
 * 收集已发布但未配单价的模型：并行拉 catalog 与 overview，取两边并集去重。
 * catalog 拉不到或 overview 尚未实现（404/字段缺失）时相应侧跳过，不阻塞渲染。
 */
function collectUnpricedModels() {
  const parseCatalog = api("/api/admin/catalog")
    .then((body) => {
      const ids = [];
      try {
        const content = JSON.parse(body.content || "{}");
        const config = content.config || {};
        const modelRules = (config.modelConfigRules || {}).builtinProviderModelRules || [];
        for (const rule of modelRules) {
          if (rule && typeof rule.modelId === "string" && rule.modelId.trim()) {
            ids.push(rule.modelId.trim());
          }
        }
        const providerRules = (config.providerConfigRules || {}).providerRules || [];
        for (const rule of providerRules) {
          const modelIds = rule && rule.config ? rule.config.builtinModelIds : null;
          if (Array.isArray(modelIds)) {
            for (const id of modelIds) {
              if (typeof id === "string" && id.trim()) ids.push(id.trim());
            }
          }
        }
      } catch {
        // 目录内容缺省或非法 JSON 时按无数据处理。
      }
      return ids;
    })
    .catch(() => []);
  const parseOverview = api("/api/admin/overview")
    .then((body) => (Array.isArray(body.unpricedModels) ? body.unpricedModels.map(String) : []))
    .catch(() => []);
  return Promise.all([parseCatalog, parseOverview]).then((results) => {
    return [...new Set(results[0].concat(results[1]))].sort();
  });
}

export function renderPrices() {
  return Promise.all([api("/api/admin/prices"), collectUnpricedModels()]).then((results) => {
    const prices = results[0].prices;
    state.priceRows = prices;
    const pricedIds = new Set(prices.map((price) => price.modelId));
    const unpriced = results[1].filter((modelId) => !pricedIds.has(modelId));
    const rows = prices
      .map(
        (price) =>
          "<tr><td>" +
          esc(price.modelId) +
          "</td><td>" +
          esc(price.input) +
          "</td><td>" +
          esc(price.output) +
          "</td><td>" +
          esc(price.cacheRead) +
          "</td><td>" +
          esc(price.cacheWrite) +
          "</td><td>" +
          esc(fmtTime(price.updatedAt)) +
          '</td><td class="actions">' +
          '<button class="btn small" data-action="edit-price" data-model="' +
          esc(price.modelId) +
          '">编辑</button>' +
          '<button class="btn small danger" data-action="delete-price" data-model="' +
          esc(price.modelId) +
          '">删除</button></td></tr>',
      )
      .join("");

    const unpricedSection =
      '<section class="section"><h2>未配价模型警示</h2>' +
      (unpriced.length === 0
        ? '<span class="muted">已发布的模型都有单价，没有遗漏。</span>'
        : '<p class="message show error">以下已发布模型未配单价，调用按 0 计费（免费）：</p><ul>' +
          unpriced
            .map(
              (modelId) =>
                "<li><code>" +
                esc(modelId) +
                '</code> <button class="btn small" data-self-action="fill-price" data-model="' +
                esc(modelId) +
                '">一键补价</button></li>',
            )
            .join("") +
          "</ul>") +
      "</section>";

    el("panel").innerHTML =
      '<section class="section"><h2>模型单价</h2>' +
      '<p class="muted">单位是「每百万 token 的金额」。模型 id 必须与客户端请求体里的 ' +
      "<code>model</code> 字段一致。新建时四项全填，想「免费」就显式填 0；" +
      "编辑时留空表示保留现值。</p>" +
      '<input type="hidden" id="price-form-mode" value="create" />' +
      '<div class="row">' +
      field("price-model", "模型 id（编辑时不可改）", "text") +
      '<div class="field"><label for="price-input">输入<span id="price-input-label-suffix"></span></label>' +
      '<input id="price-input" type="text" required /></div>' +
      '<div class="field"><label for="price-output">输出<span id="price-output-label-suffix"></span></label>' +
      '<input id="price-output" type="text" required /></div>' +
      '<div class="field"><label for="price-cache-read">缓存读<span id="price-cache-read-label-suffix"></span></label>' +
      '<input id="price-cache-read" type="text" required /></div>' +
      '<div class="field"><label for="price-cache-write">缓存写<span id="price-cache-write-label-suffix"></span></label>' +
      '<input id="price-cache-write" type="text" required /></div>' +
      '<button class="btn primary" id="save-price">保存</button></div>' +
      '<div id="price-message" class="message"></div></section>' +
      unpricedSection +
      '<section class="section"><h2>已配置单价</h2>' +
      (prices.length === 0
        ? '<span class="muted">还没有配置任何单价。</span>'
        : '<div class="table-scroll"><table><thead><tr><th>模型</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>更新时间</th><th>操作</th></tr></thead><tbody>' +
          rows +
          "</tbody></table></div>") +
      "</section>";

    resetPriceForm();

    el("save-price").onclick = () => {
      const mode = el("price-form-mode").value;
      const modelId = el("price-model").value.trim();
      if (!modelId) {
        showMessage("price-message", "模型 id 不能为空", "error");
        return;
      }
      if (mode === "edit" && !state.priceRows.some((item) => item.modelId === modelId)) {
        showMessage("price-message", "该模型单价已不存在，请刷新后重试", "error");
        return;
      }
      const payload = {
        input: el("price-input").value,
        output: el("price-output").value,
        cacheRead: el("price-cache-read").value,
        cacheWrite: el("price-cache-write").value,
      };
      // 新建时四项都必须非空（后端对新建没有 readOrKeep）；编辑时留空 = 保留现值。
      if (
        mode === "create" &&
        (!payload.input.trim() ||
          !payload.output.trim() ||
          !payload.cacheRead.trim() ||
          !payload.cacheWrite.trim())
      ) {
        showMessage(
          "price-message",
          "新建单价时输入/输出/缓存读/缓存写都必须填写（想免费就填 0）",
          "error",
        );
        return;
      }
      api("/api/admin/prices/" + encodeURIComponent(modelId), {
        method: "PUT",
        body: JSON.stringify(payload),
      })
        .then(() => {
          showMessage("price-message", "已保存", "ok");
          renderPrices();
        })
        .catch((error) => showMessage("price-message", error.message, "error"));
    };

    // "一键补价"也是本页私有动作，自己绑定 click。
    for (const button of el("panel").querySelectorAll("[data-self-action='fill-price']")) {
      button.onclick = () => {
        prefillPriceForm(button.dataset.model);
        showMessage(
          "price-message",
          "已载入模型 " + button.dataset.model + "，请填写单价后保存",
          "warn",
        );
      };
    }
  });
}

/**
 * 从已发布目录解析可选模型清单：builtinProviderModelRules[].modelId 与
 * providerRules[].config.builtinModelIds 的并集。目录拉不到或结构异常时返回 null，
 * 调用方退化为逗号分隔文本输入。
 */
function publishedModelOptions(catalogBody) {
  let root;
  try {
    root = JSON.parse(catalogBody.content || "{}");
  } catch {
    return null;
  }
  const config = root && root.config ? root.config : null;
  const modelRules = config && config.modelConfigRules ? config.modelConfigRules : null;
  const providerRules =
    config && config.providerConfigRules ? config.providerConfigRules.providerRules : null;
  if (!modelRules || !providerRules) return null;
  const ids = new Set();
  for (const rule of modelRules.builtinProviderModelRules || []) {
    if (rule && typeof rule.modelId === "string" && rule.modelId.trim()) {
      ids.add(rule.modelId.trim());
    }
  }
  for (const rule of providerRules) {
    const configPart = rule && rule.config ? rule.config : null;
    const modelIds = configPart ? configPart.builtinModelIds : null;
    if (Array.isArray(modelIds)) {
      for (const id of modelIds) {
        if (typeof id === "string" && id.trim()) ids.add(id.trim());
      }
    }
  }
  return [...ids].sort();
}

export function renderPlans() {
  return Promise.all([
    api("/api/admin/plans"),
    api("/api/admin/catalog").catch(dashRethrowAuth),
  ]).then((results) => {
    state.plans = results[0].plans;
    const catalogBody = results[1];
    const modelOptions = catalogBody ? publishedModelOptions(catalogBody) : null;

    const rows = state.plans
      .map(
        (plan) =>
          "<tr><td>" +
          esc(plan.name) +
          "</td><td>" +
          esc(plan.quota) +
          "</td><td>" +
          esc(plan.durationDays === null ? "长期" : plan.durationDays + " 天") +
          "</td><td>" +
          esc(plan.allowedModels.length === 0 ? "不限制" : plan.allowedModels.join(", ")) +
          '</td><td class="actions">' +
          '<button class="btn small" data-action="edit-plan" data-id="' +
          esc(plan.id) +
          '">编辑</button>' +
          '<button class="btn small danger" data-action="delete-plan" data-id="' +
          esc(plan.id) +
          '">删除</button></td></tr>',
      )
      .join("");

    // 新建/编辑双模式：隐藏域记录当前模式与编辑目标，编辑时预填现有值。
    const modelsField = modelOptions
      ? '<div class="field"><label for="plan-models">限定模型（按住 Ctrl/Cmd 多选，留空不限制）</label>' +
        '<select id="plan-models" multiple size="6">' +
        modelOptions
          .map((id) => '<option value="' + esc(id) + '">' + esc(id) + "</option>")
          .join("") +
        "</select></div>"
      : '<div class="field"><label for="plan-models-text">限定模型（逗号分隔，留空不限制）</label>' +
        '<input id="plan-models-text" type="text" /></div>';

    el("panel").innerHTML =
      '<section class="section"><h2 id="plan-form-title">新建套餐</h2>' +
      '<p class="muted">套餐提供额度池，并可选限定可用模型。额度用尽后继续按余额扣费；' +
      "编辑套餐只影响之后发放的订阅，不改变已发放订阅的剩余额度。</p>" +
      '<input id="plan-form-mode" type="hidden" value="create" />' +
      '<input id="plan-edit-id" type="hidden" value="" />' +
      '<div class="row">' +
      field("plan-name", "名称", "text") +
      field("plan-quota", "额度（如 100）", "text") +
      field("plan-days", "有效天数（留空为长期）", "text") +
      modelsField +
      '<button class="btn primary" id="save-plan">创建</button>' +
      '<button class="btn hidden" id="cancel-edit-plan">取消编辑</button></div>' +
      '<div id="plan-message" class="message"></div></section>' +
      '<section class="section"><h2>已有套餐</h2>' +
      (state.plans.length === 0
        ? '<span class="muted">还没有套餐。</span>'
        : "<table><thead><tr><th>名称</th><th>额度</th><th>有效期</th><th>限定模型</th><th>操作</th></tr></thead><tbody>" +
          rows +
          "</tbody></table>") +
      "</section>";

    const enterEditMode = (plan) => {
      el("plan-form-title").textContent = "编辑套餐：" + plan.name;
      el("plan-form-mode").value = "edit";
      el("plan-edit-id").value = plan.id;
      el("plan-name").value = plan.name;
      el("plan-quota").value = plan.quota;
      el("plan-days").value = plan.durationDays === null ? "" : String(plan.durationDays);
      if (modelOptions) {
        const select = el("plan-models");
        for (const option of select.options) {
          option.selected = plan.allowedModels.includes(option.value);
        }
      } else {
        el("plan-models-text").value = plan.allowedModels.join(", ");
      }
      el("save-plan").textContent = "保存修改";
      el("cancel-edit-plan").className = "btn";
    };

    const exitEditMode = () => {
      el("plan-form-title").textContent = "新建套餐";
      el("plan-form-mode").value = "create";
      el("plan-edit-id").value = "";
      el("plan-name").value = "";
      el("plan-quota").value = "";
      el("plan-days").value = "";
      if (modelOptions) {
        const select = el("plan-models");
        for (const option of select.options) option.selected = false;
      } else {
        el("plan-models-text").value = "";
      }
      el("save-plan").textContent = "创建";
      el("cancel-edit-plan").className = "btn hidden";
      showMessage("plan-message", "");
    };

    el("cancel-edit-plan").onclick = exitEditMode;

    el("save-plan").onclick = () => {
      const mode = el("plan-form-mode").value;
      const editId = el("plan-edit-id").value;
      const name = el("plan-name").value;
      const quota = el("plan-quota").value;
      const daysRaw = el("plan-days").value.trim();
      const allowedModels = modelOptions
        ? [...el("plan-models").selectedOptions].map((option) => option.value)
        : el("plan-models-text")
            .value.split(",")
            .map((item) => item.trim())
            .filter(Boolean);
      const payload = {
        name,
        quota,
        durationDays: daysRaw ? Number(daysRaw) : null,
        allowedModels,
      };
      const request =
        mode === "edit" && editId
          ? api("/api/admin/plans/" + encodeURIComponent(editId), {
              method: "PATCH",
              body: JSON.stringify(payload),
            })
          : api("/api/admin/plans", { method: "POST", body: JSON.stringify(payload) });
      request
        .then(() => {
          showMessage("plan-message", mode === "edit" ? "套餐已保存" : "套餐已创建", "ok");
          renderPlans();
        })
        .catch((error) => showMessage("plan-message", error.message, "error"));
    };

    // 编辑按钮由 app.js 全局委托并 dispatch screen:plans 事件；载入函数在模块顶层登记。
    planFormLoader = (editId) => {
      const plan = state.plans.find((item) => item.id === editId);
      if (!plan) return;
      enterEditMode(plan);
      el("panel").scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });
}

export function renderReleases() {
  return api("/api/admin/releases").then((body) => {
    const releases = body.releases;
    const rows = releases
      .map(
        (release) =>
          "<tr><td>" +
          esc(release.version) +
          "</td><td>" +
          esc(release.channel) +
          "</td><td>" +
          esc(release.platform) +
          "</td><td>" +
          esc(release.fileName) +
          "</td><td>" +
          esc(fmtBytes(release.sizeBytes)) +
          "</td><td>" +
          (release.releaseNotes
            ? '<span title="' +
              esc(release.releaseNotes) +
              '">' +
              esc(
                release.releaseNotes.length > 20
                  ? release.releaseNotes.slice(0, 20) + "…"
                  : release.releaseNotes,
              ) +
              "</span>"
            : '<span class="muted">-</span>') +
          "</td><td>" +
          esc(fmtTime(release.createdAt)) +
          '</td><td class="actions">' +
          '<button class="btn small" data-action="copy-text" data-copy-value="' +
          esc(window.location.origin + release.downloadPath) +
          '">复制链接</button>' +
          ' <a class="btn small" target="_blank" rel="noreferrer" href="' +
          esc(release.downloadPath) +
          '">打开</a>' +
          '<button class="btn small danger" data-action="delete-release" data-id="' +
          esc(release.id) +
          '">删除</button></td></tr>',
      )
      .join("");

    el("panel").innerHTML =
      '<section class="section"><h2>发布客户端版本</h2>' +
      '<p class="muted">上传安装包后平台会计算 sha512 并登记。' +
      "客户端在下次检查更新时（启动时与每小时）就能看到这个版本。" +
      "<br />平台参数必须与客户端请求一致，支持： " +
      "<code>windows-x86_64</code>、<code>windows-aarch64</code>、<code>darwin-x86_64</code>、" +
      "<code>darwin-aarch64</code>、<code>linux-x86_64</code>、<code>linux-aarch64</code>。" +
      "<br /><strong>唯一约束</strong>：登记键是（版本 + 平台 + 通道），同一平台同版本只保留一个文件；" +
      "对同一键重复上传会<strong>覆盖</strong>已有登记。建议 macOS 登记能够自动更新的 " +
      "<code>.zip</code>，<code>.dmg</code> 作为手动安装包分发。" +
      "<br /><strong>注意</strong>：未签名的安装包在 macOS 上无法自动安装（系统会拒绝），" +
      "Windows 也会被 SmartScreen 拦截，此时应手动分发给用户。" +
      "<br />发布说明登记后不可修改（如需改动只能删除后重新上传）；" +
      "强制更新入口在「运营」页的系统设置里。</p>" +
      '<div class="row">' +
      field("release-version", "版本号（如 3.15.0）", "text") +
      '<div class="field"><label for="release-platform">平台</label><select id="release-platform">' +
      [
        "windows-x86_64",
        "windows-aarch64",
        "darwin-x86_64",
        "darwin-aarch64",
        "linux-x86_64",
        "linux-aarch64",
      ]
        .map((item) => '<option value="' + item + '">' + item + "</option>")
        .join("") +
      "</select></div>" +
      '<div class="field"><label for="release-channel">通道</label><select id="release-channel">' +
      '<option value="stable">stable</option><option value="preview">preview</option></select></div>' +
      '<div class="field"><label for="release-file">安装包文件</label><input id="release-file" type="file" /></div>' +
      field("release-notes", "发布说明（可选，登记后不可修改）", "text") +
      '<button class="btn primary" id="upload-release">上传并发布</button>' +
      "</div>" +
      '<div class="field"><label>上传进度</label>' +
      '<progress id="release-progress" value="0" max="100" style="width: 100%"></progress></div>' +
      '<div id="release-message" class="message"></div></section>' +
      '<section class="section"><h2>已登记版本</h2>' +
      (releases.length === 0
        ? '<span class="muted">还没有登记任何版本。</span>'
        : '<div class="table-scroll"><table><thead><tr><th>版本</th><th>通道</th><th>平台</th><th>文件名</th><th>大小</th><th>发布说明</th><th>登记时间</th><th>操作</th></tr></thead><tbody>' +
          rows +
          "</tbody></table></div>") +
      "</section>";

    // fetch 不支持上传进度，这里用 XMLHttpRequest 显示进度条。
    el("upload-release").onclick = () => {
      const version = el("release-version").value.trim();
      const file = el("release-file").files[0];
      if (!version || !file) {
        showMessage("release-message", "请填写版本号并选择安装包", "error");
        return;
      }
      const query =
        "?platform=" +
        encodeURIComponent(el("release-platform").value) +
        "&channel=" +
        encodeURIComponent(el("release-channel").value) +
        "&releaseNotes=" +
        encodeURIComponent(el("release-notes").value);
      const progress = el("release-progress");
      const button = el("upload-release");
      progress.value = 0;
      button.disabled = true;
      showMessage("release-message", "上传中，请勿关闭页面…", "warn");
      const xhr = new XMLHttpRequest();
      xhr.open(
        "PUT",
        "/api/admin/releases/" +
          encodeURIComponent(version) +
          "/" +
          encodeURIComponent(file.name) +
          query,
      );
      xhr.setRequestHeader("authorization", "Bearer " + getToken());
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          progress.value = Math.round((event.loaded / event.total) * 100);
        }
      };
      xhr.onload = () => {
        button.disabled = false;
        if (xhr.status >= 200 && xhr.status < 300) {
          showMessage("release-message", "已发布 " + version, "ok");
          renderReleases();
        } else {
          let message = "上传失败（" + xhr.status + "）";
          try {
            const parsed = JSON.parse(xhr.responseText);
            if (parsed && parsed.error && parsed.error.message) message = parsed.error.message;
          } catch {
            // 非 JSON 错误体按默认文案处理。
          }
          showMessage("release-message", message, "error");
        }
      };
      xhr.onerror = () => {
        button.disabled = false;
        showMessage("release-message", "网络错误，上传失败", "error");
      };
      // body 是 File：不要设置 content-type，让浏览器按原始二进制发送。
      xhr.send(file);
    };
  });
}

// 注册各页：queueMicrotask 等 app.js 的 SCREENS 完成初始化（见 screens-users.js 头注释）。
queueMicrotask(() => {
  registerScreen("providers", renderProviders);
  registerScreen("prices", renderPrices);
  registerScreen("plans", renderPlans);
  registerScreen("releases", renderReleases);
});

// 套餐页的「编辑」按钮由 app.js 全局委托并通过 screen:plans 自定义事件转发。
// 监听器在模块顶层只挂一次；renderPlans 每次渲染时替换载入函数，避免重复绑定。
let planFormLoader = null;
document.addEventListener("screen:plans", (event) => {
  if (planFormLoader) planFormLoader(event.detail ? event.detail.edit : null);
});

// ══ 概览 / 模型发布 / 目录 JSON ──────────────────────────────────────────────
// 本 section 拥有 dashboard（概览）、catalog（模型发布基础版）、catalog-json（目录 JSON）
// 三个屏幕；与文件前半部分的 providers/prices/plans/releases 各页互不依赖。
// 后端契约：GET /api/admin/overview?sinceDays、GET /api/admin/usage/by-model、
// GET /api/admin/usage、GET /api/admin/ledger、POST /api/admin/catalog/publish、
// GET|PUT /api/admin/catalog，以及公开只读的 GET /api/v1/catalog/<rev>.json。
// 契约中"后端实现中"的字段一律容错：缺失渲染 "-"，接口暂不可用渲染占位文案。

/** 看板页本地视图状态：时间范围与两张分页表的偏移（切 tab 后保留）。 */
const dashboardView = {
  rangeDays: 30,
  usageOffset: 0,
  ledgerOffset: 0,
  ledgerEntries: [],
};

/** 目录 JSON 页本地视图状态：最近一次查看的历史 revision（"上一版"从它继续回退）。 */
const catalogJsonView = { historyRevision: null };

const DASH_PAGE_SIZE = 20;

/** 数值容错：契约字段可能缺失，缺失渲染 "-"。 */
function dashNum(value) {
  return value === null || value === undefined ? "-" : String(value);
}

/** 金额容错：优先 micros 数值，其次后端已格式化的字符串。 */
function dashMoney(micros, formatted) {
  if (typeof micros === "number") return fmtMicros(micros);
  return formatted || "-";
}

/**
 * 容错 catch 的统一出口：登录失效（401/403）必须继续上抛，
 * 让 app.js 的 handleAuthFailure 走统一登出；其余缺失按占位渲染。
 */
function dashRethrowAuth(error) {
  if (error && (error.status === 401 || error.status === 403)) throw error;
  return null;
}

/**
 * 看板内分页控件。api.js 的 renderPagination 全局只绑文档里第一个分页盒，
 * 看板同屏有两张分页表会互相抢占，这里按容器各自绑定（外观同款式）。
 */
function dashPaginationHtml(total, limit, offset) {
  if (!total || total <= limit) return "";
  const pages = Math.ceil(total / limit);
  const page = Math.floor(offset / limit) + 1;
  const button = (target, label, disabled, isCurrent) =>
    '<button class="btn small' +
    (isCurrent ? " primary" : "") +
    '" data-page-offset="' +
    target +
    '"' +
    (disabled ? " disabled" : "") +
    ">" +
    label +
    "</button>";
  return (
    '<div class="pagination">' +
    button(0, "« 首页", offset === 0, false) +
    button(Math.max(0, offset - limit), "‹ 上一页", offset === 0, false) +
    button(offset, "第 " + page + " / " + pages + " 页", true, true) +
    button(
      Math.min((pages - 1) * limit, offset + limit),
      "下一页 ›",
      offset + limit >= total,
      false,
    ) +
    button((pages - 1) * limit, "末页 »", offset + limit >= total, false) +
    "</div>"
  );
}

/** 把容器内分页盒的点击转成 offset 回调；section 随 innerHTML 重建，绑定随之重来。 */
function dashBindPagination(container, onPage) {
  const box = container.querySelector(".pagination");
  if (!box) return;
  box.addEventListener("click", (event) => {
    const target = event.target;
    if (target && target.dataset && target.dataset.pageOffset !== undefined && !target.disabled) {
      onPage(Number(target.dataset.pageOffset));
    }
  });
}

/** 调用状态徽标：ok 绿色，其余（upstream_error / rejected 等）红色。 */
function dashStatusBadge(status) {
  if (!status) return '<span class="badge">-</span>';
  return (
    '<span class="badge ' + (status === "ok" ? "ok" : "danger") + '">' + esc(status) + "</span>"
  );
}

/** 用量表里的 token 摘要（fmtTokens 口径太长，表格里只放入/出）。 */
function dashUsageText(tokens) {
  if (!tokens) return "-";
  return "入 " + (tokens.inputTokens || 0) + " / 出 " + (tokens.outputTokens || 0);
}

// ── 概览（dashboard）────────────────────────────────────────

function dashOverviewSectionHtml(overview, days) {
  const t30 = (overview && overview.totals30) || {};
  const today = (overview && overview.totalsToday) || {};
  const options = [7, 30, 90]
    .map(
      (value) =>
        '<option value="' +
        value +
        '"' +
        (value === days ? " selected" : "") +
        ">近 " +
        value +
        " 天</option>",
    )
    .join("");
  return (
    '<section class="section"><h2>概览</h2>' +
    '<div class="row">' +
    '<div class="field"><label for="range-days">时间范围（作用于「近 N 天」与排行）</label>' +
    '<select id="range-days">' +
    options +
    "</select></div></div>" +
    '<div class="metrics">' +
    metric("今日调用", dashNum(today.requestCount)) +
    metric("今日失败", dashNum(today.errorCount)) +
    metric("今日消费", dashMoney(today.costMicros, overview && overview.costToday)) +
    metric(
      "今日充值",
      dashMoney(overview && overview.rechargeTodayMicros, overview && overview.rechargeToday),
    ) +
    "</div>" +
    '<div class="metrics">' +
    metric("近 " + days + " 天调用", dashNum(t30.requestCount)) +
    metric("近 " + days + " 天失败", dashNum(t30.errorCount)) +
    metric("近 " + days + " 天输入 token", dashNum(t30.inputTokens)) +
    metric("近 " + days + " 天输出 token", dashNum(t30.outputTokens)) +
    metric("近 " + days + " 天消费", dashMoney(t30.costMicros, t30.cost)) +
    "</div>" +
    '<div class="metrics">' +
    '<div class="metric"><div class="metric-label">平台负债</div><div class="metric-value">' +
    esc(dashMoney(overview && overview.liabilityMicros, overview && overview.liability)) +
    ' <span class="badge danger">用户余额合计 = 平台负债</span></div></div>' +
    metric("用户数", dashNum(overview && overview.userCount)) +
    "</div>" +
    (overview
      ? ""
      : '<p class="muted">概览接口（/api/admin/overview）暂不可用，以上数字待后端就绪后展示。</p>') +
    "</section>"
  );
}

/** 未配价模型警示：字段缺失时整个区块跳过；空数组显示绿色通过徽标。 */
function dashUnpricedSectionHtml(overview) {
  if (!overview || !Array.isArray(overview.unpricedModels)) return "";
  const models = overview.unpricedModels;
  if (models.length === 0) {
    return (
      '<section class="section"><h2>计费覆盖</h2>' +
      '<span class="badge ok">所有已发布模型均已配价</span></section>'
    );
  }
  return (
    '<section class="section"><h2>未配价模型警示</h2>' +
    '<p class="muted">以下已发布模型没有配置单价，调用将按 0 计费（免费）。请到「单价」页补配：</p>' +
    '<div class="table-scroll"><table><tbody>' +
    models.map((id) => '<tr class="row-warn"><td class="mono">' + esc(id) + "</td></tr>").join("") +
    "</tbody></table></div></section>"
  );
}

function dashByModelSectionHtml(byModel) {
  if (!byModel) {
    return (
      '<section class="section"><h2>按模型统计</h2>' +
      '<span class="muted">按模型统计接口暂不可用。</span></section>'
    );
  }
  const rows = byModel.rows || [];
  const body =
    rows.length === 0
      ? '<span class="muted">该时间范围内没有调用记录。</span>'
      : '<div class="table-scroll"><table><thead><tr><th>模型</th><th>调用</th><th>失败</th><th>输入</th><th>输出</th><th>消费</th></tr></thead><tbody>' +
        rows
          .map((row) => {
            const totals = row.totals || {};
            return (
              "<tr><td>" +
              esc(row.modelId || "-") +
              "</td><td>" +
              dashNum(totals.requestCount) +
              "</td><td>" +
              dashNum(totals.errorCount) +
              "</td><td>" +
              dashNum(totals.inputTokens) +
              "</td><td>" +
              dashNum(totals.outputTokens) +
              "</td><td>" +
              esc(dashMoney(totals.costMicros, totals.cost)) +
              "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table></div>";
  return '<section class="section"><h2>按模型统计</h2>' + body + "</section>";
}

function dashUsageInner(records, total) {
  const body =
    records.length === 0
      ? '<span class="muted">该时间范围内没有调用记录。</span>'
      : '<div class="table-scroll"><table><thead><tr><th>时间</th><th>用户</th><th>模型</th><th>状态</th><th>用量</th><th>费用</th><th>操作</th></tr></thead><tbody>' +
        records
          .map((record, index) => {
            const errorCell = record.errorMessage
              ? '<button class="btn small" type="button" data-usage-error-toggle="dash-usage-error-' +
                index +
                '">查看错误</button>'
              : "";
            const errorRow = record.errorMessage
              ? '<tr id="dash-usage-error-' +
                index +
                '" class="hidden"><td colspan="7" class="mono">HTTP ' +
                esc(dashNum(record.httpStatus)) +
                "：" +
                esc(record.errorMessage) +
                "</td></tr>"
              : "";
            return (
              "<tr><td>" +
              esc(fmtTime(record.createdAt)) +
              "</td><td>" +
              esc(record.userId || "-") +
              "</td><td>" +
              esc(record.modelId || "-") +
              "</td><td>" +
              dashStatusBadge(record.status) +
              "</td><td>" +
              esc(dashUsageText(record.tokens)) +
              "</td><td>" +
              esc(dashMoney(record.costMicros, record.cost)) +
              '</td><td class="actions">' +
              errorCell +
              "</td></tr>" +
              errorRow
            );
          })
          .join("") +
        "</tbody></table></div>";
  return (
    "<h2>全站调用明细</h2>" +
    body +
    dashPaginationHtml(total, DASH_PAGE_SIZE, dashboardView.usageOffset)
  );
}

function dashBindUsageSection(section) {
  dashBindPagination(section, (offset) => {
    dashboardView.usageOffset = offset;
    dashReloadUsage();
  });
  for (const button of section.querySelectorAll("[data-usage-error-toggle]")) {
    button.onclick = () => {
      const row = el(button.dataset.usageErrorToggle);
      if (row) row.classList.toggle("hidden");
    };
  }
}

function dashReloadUsage() {
  return api(
    "/api/admin/usage?limit=" +
      DASH_PAGE_SIZE +
      "&offset=" +
      dashboardView.usageOffset +
      "&sinceDays=" +
      dashboardView.rangeDays,
  )
    .then((body) => {
      const section = el("dashboard-usage");
      if (!section) return;
      section.innerHTML = dashUsageInner(body.records || [], body.total || 0);
      dashBindUsageSection(section);
    })
    .catch((error) => {
      // 翻页失败不整页重载：登录失效上抛，其余就地提示。
      if (error && (error.status === 401 || error.status === 403)) throw error;
      toast(error.message, true);
    });
}

/** 前端拼 CSV（只含当前页数据）：单元格统一加引号并转义内部引号。 */
function dashLedgerCsv(entries) {
  const lines = ["\ufeff时间,类型,方向,金额,备注"];
  for (const entry of entries) {
    const cells = [
      entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "-",
      entry.kind || "",
      entry.direction === "debit" ? "支出" : "入账",
      (entry.direction === "debit" ? "-" : "+") + (entry.amount != null ? entry.amount : ""),
      entry.note || "",
    ];
    lines.push(cells.map((cell) => '"' + String(cell).replace(/"/g, '""') + '"').join(","));
  }
  return lines.join("\r\n");
}

function dashDownloadLedgerCsv() {
  // BOM 头让 Excel 按 UTF-8 识别中文；a.download 触发浏览器下载而不是跳转。
  const blob = new Blob([dashLedgerCsv(dashboardView.ledgerEntries)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "ledger.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function dashLedgerInner(entries, total) {
  const body =
    entries.length === 0
      ? '<span class="muted">没有流水记录。</span>'
      : '<div class="table-scroll"><table><thead><tr><th>时间</th><th>类型</th><th>金额</th><th>备注</th></tr></thead><tbody>' +
        entries
          .map(
            (entry) =>
              "<tr><td>" +
              esc(fmtTime(entry.createdAt)) +
              "</td><td>" +
              esc(entry.kind || "-") +
              "</td><td>" +
              esc(
                (entry.direction === "debit" ? "-" : "+") +
                  (entry.amount != null ? entry.amount : "-"),
              ) +
              "</td><td>" +
              esc(entry.note || "-") +
              "</td></tr>",
          )
          .join("") +
        "</tbody></table></div>";
  return (
    "<h2>全站流水</h2>" +
    '<p class="muted">流水接口不支持时间范围过滤，固定展示最新记录；金额列已带方向符号。</p>' +
    body +
    dashPaginationHtml(total, DASH_PAGE_SIZE, dashboardView.ledgerOffset) +
    '<div class="row"><button class="btn small" type="button" id="dash-ledger-csv">导出当前页 CSV</button></div>'
  );
}

function dashBindLedgerSection(section) {
  dashBindPagination(section, (offset) => {
    dashboardView.ledgerOffset = offset;
    dashReloadLedger();
  });
  const csvButton = section.querySelector("#dash-ledger-csv");
  if (csvButton) csvButton.onclick = dashDownloadLedgerCsv;
}

function dashReloadLedger() {
  return api("/api/admin/ledger?limit=" + DASH_PAGE_SIZE + "&offset=" + dashboardView.ledgerOffset)
    .then((body) => {
      const section = el("dashboard-ledger");
      if (!section) return;
      dashboardView.ledgerEntries = body.entries || [];
      section.innerHTML = dashLedgerInner(dashboardView.ledgerEntries, body.total || 0);
      dashBindLedgerSection(section);
    })
    .catch((error) => {
      // 翻页失败不整页重载：登录失效上抛，其余就地提示。
      if (error && (error.status === 401 || error.status === 403)) throw error;
      toast(error.message, true);
    });
}

export function renderDashboard() {
  const days = dashboardView.rangeDays;
  return Promise.all([
    api("/api/admin/overview?sinceDays=" + days).catch(dashRethrowAuth),
    api("/api/admin/usage/by-model?sinceDays=" + days + "&limit=20").catch(dashRethrowAuth),
    api(
      "/api/admin/usage?limit=" +
        DASH_PAGE_SIZE +
        "&offset=" +
        dashboardView.usageOffset +
        "&sinceDays=" +
        days,
    ).catch(dashRethrowAuth),
    api(
      "/api/admin/ledger?limit=" + DASH_PAGE_SIZE + "&offset=" + dashboardView.ledgerOffset,
    ).catch(dashRethrowAuth),
  ]).then((results) => {
    const overview = results[0];
    const byModel = results[1];
    const usage = results[2] || { records: [], total: 0 };
    const ledger = results[3] || { entries: [], total: 0 };
    dashboardView.ledgerEntries = ledger.entries || [];
    el("panel").innerHTML =
      dashOverviewSectionHtml(overview, days) +
      dashUnpricedSectionHtml(overview) +
      dashByModelSectionHtml(byModel) +
      '<section class="section" id="dashboard-usage">' +
      dashUsageInner(usage.records || [], usage.total || 0) +
      "</section>" +
      '<section class="section" id="dashboard-ledger">' +
      dashLedgerInner(dashboardView.ledgerEntries, ledger.total || 0) +
      "</section>";

    el("range-days").onchange = () => {
      dashboardView.rangeDays = Number(el("range-days").value) || 30;
      dashboardView.usageOffset = 0;
      dashboardView.ledgerOffset = 0;
      renderDashboard();
    };
    dashBindUsageSection(el("dashboard-usage"));
    dashBindLedgerSection(el("dashboard-ledger"));
  });
}

// ── 目录 JSON 维护（catalog-json）───────────────────────────

export function renderCatalogJson() {
  return Promise.all([
    api("/api/admin/catalog").catch(dashRethrowAuth),
    api("/api/admin/catalog/builtin").catch(dashRethrowAuth),
  ]).then((results) => {
    const catalog = results[0];
    const builtin = results[1] && results[1].builtin ? results[1].builtin : null;
    if (!catalog) {
      el("panel").innerHTML =
        '<section class="section"><h2>目录 JSON 维护</h2>' +
        '<span class="muted">目录接口暂不可用，请稍后重试。</span></section>';
      return;
    }
    const revision = catalog.revision;
    const summary = catalog.summary;
    const raw = catalog.content || "";
    // 保存失败的错误信息会包含 revision 下限（catalogService 的 update 校验）。
    const floor = Math.max(revision || 0, (builtin && builtin.revision) || 0);
    let pretty = raw;
    try {
      if (raw) pretty = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      // 目录内容异常时按原文展示，不让页面挂掉。
    }

    el("panel").innerHTML =
      '<section class="section"><h2>目录 JSON 维护</h2>' +
      '<p class="muted"><strong>优先用「模型发布」页生成目录</strong>；本页手改 JSON 仅限微调。' +
      "保存时顶层 <code>revision</code> 必须大于 max(当前 " +
      esc(revision == null ? "（尚未导入）" : revision) +
      ", 内置 " +
      esc(builtin ? builtin.revision : "（未携带）") +
      ") = " +
      esc(floor) +
      "，否则保存会被拒绝（错误信息会包含该下限）。" +
      "目录里<strong>不要写真实上游 API key</strong>：它是全站共享、任何人可下载的。</p>" +
      '<div class="row">' +
      '<div class="field"><label>当前 revision</label><input value="' +
      esc(revision == null ? "（尚未导入）" : revision) +
      '" disabled /></div>' +
      '<div class="field"><label>摘要</label><input value="' +
      esc(
        summary
          ? "provider " + summary.providerCount + " 个 / 模型 " + summary.modelCount + " 条"
          : "（无）",
      ) +
      '" disabled /></div>' +
      '<button class="btn" type="button" id="cjson-edit">编辑 JSON</button>' +
      '<button class="btn" type="button" id="cjson-reload">重新加载</button>' +
      "</div>" +
      '<div id="cjson-message" class="message"></div>' +
      '<details id="cjson-preview"><summary>当前目录 JSON 预览（revision ' +
      esc(revision == null ? "-" : revision) +
      "）</summary><pre>" +
      esc(pretty || "（空）") +
      "</pre></details>" +
      '<div id="cjson-editor" class="hidden">' +
      '<p class="muted">编辑提示：把顶层 revision 改成大于 ' +
      esc(floor) +
      " 的整数；并发保护以打开页面时的 revision（" +
      esc(revision == null ? "null" : revision) +
      "）作为 expectedRevision 提交，两个管理员并发保存时后提交者会收到冲突错误。</p>" +
      '<textarea id="cjson-content" spellcheck="false">' +
      esc(raw) +
      "</textarea>" +
      '<div class="row"><button class="btn primary" type="button" id="cjson-save">保存</button>' +
      '<button class="btn" type="button" id="cjson-cancel">取消编辑</button></div>' +
      "</div></section>" +
      '<section class="section"><h2>历史回看</h2>' +
      '<p class="muted">历史 revision 经公开只读接口 <code>/api/v1/catalog/&lt;rev&gt;.json</code> 查看；' +
      "从当前 revision 往回逐版回看（到 1 为止）。</p>" +
      '<div class="row">' +
      '<div class="field"><label for="cjson-history-revision">revision 数字</label>' +
      '<input id="cjson-history-revision" type="number" min="1" step="1" value="' +
      esc(revision == null ? "" : revision) +
      '" /></div>' +
      '<button class="btn" type="button" id="cjson-history-view">查看</button>' +
      '<button class="btn" type="button" id="cjson-history-prev">上一版</button>' +
      "</div>" +
      '<div id="cjson-history-message" class="message"></div>' +
      '<pre id="cjson-history-pre" class="hidden"></pre></section>';

    el("cjson-edit").onclick = () => {
      el("cjson-preview").className = "hidden";
      el("cjson-editor").className = "";
      showMessage("cjson-message", "");
    };
    el("cjson-cancel").onclick = () => renderCatalogJson();
    el("cjson-reload").onclick = () => renderCatalogJson();
    el("cjson-save").onclick = () => {
      const content = el("cjson-content").value;
      try {
        JSON.parse(content);
      } catch (error) {
        showMessage("cjson-message", "内容不是合法 JSON：" + error.message, "error");
        return;
      }
      el("cjson-save").disabled = true;
      api("/api/admin/catalog", {
        method: "PUT",
        body: JSON.stringify({ content, expectedRevision: revision }),
      })
        .then((body) => {
          toast("已保存为 revision " + body.revision);
          renderCatalogJson();
        })
        .catch((error) => {
          showMessage("cjson-message", error.message, "error");
          el("cjson-save").disabled = false;
        });
    };

    const fetchHistory = (target) => {
      showMessage("cjson-history-message", "加载中…", "warn");
      api("/api/v1/catalog/" + target + ".json")
        .then((body) => {
          catalogJsonView.historyRevision = target;
          const pre = el("cjson-history-pre");
          pre.classList.remove("hidden");
          // textContent 赋值，不经 innerHTML：历史内容只读展示，天然免转义。
          pre.textContent = "revision " + target + "：\n" + JSON.stringify(body, null, 2);
          showMessage("cjson-history-message", "");
        })
        .catch((error) => {
          el("cjson-history-pre").classList.add("hidden");
          showMessage(
            "cjson-history-message",
            error.status === 404 ? "该 revision 不存在" : error.message,
            "error",
          );
        });
    };
    el("cjson-history-view").onclick = () => {
      const target = Number(el("cjson-history-revision").value);
      if (!Number.isSafeInteger(target) || target < 1) {
        showMessage("cjson-history-message", "请输入正整数 revision", "error");
        return;
      }
      fetchHistory(target);
    };
    el("cjson-history-prev").onclick = () => {
      const base = catalogJsonView.historyRevision || revision || floor;
      const target = base - 1;
      if (target < 1) {
        showMessage("cjson-history-message", "已经是第一版", "warn");
        return;
      }
      el("cjson-history-revision").value = target;
      fetchHistory(target);
    };
  });
}

// 注册本 section 的屏幕：queueMicrotask 等 app.js 的 SCREENS 完成初始化。
// 「模型发布」tab 由 screens-publish.js 注册（/api/admin/publish 设置+预览+应用），
// 这里的目录页只承担"目录 JSON 维护"职责（tab 名：模型目录）。
queueMicrotask(() => {
  registerScreen("dashboard", renderDashboard);
  registerScreen("catalog", renderCatalogJson);
});
