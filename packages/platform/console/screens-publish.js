/**
 * 管理后台：模型发布页（specs/platform/model-publish.md）。
 * 流程：拉取模型 → 勾选 → 编辑显示名/能力 → 保存 → 预览/推送。
 * 显示名即客户端目录里的 modelId（展示与请求都用它，真实模型 ID 绝不进目录，
 * 网关按 (providerId, 显示名) 改写回真实 ID）；同一上游内显示名不能重复。
 */
import { registerScreen } from "./app.js";
import { api, el, esc, showMessage, state } from "./api.js";

const CLIENT_PROTOCOLS = ["anthropic-messages", "openai-chat-completions", "openai-responses"];

const THINKING_LEVELS = ["disabled", "enabled", "minimal", "low", "medium", "high", "xhigh", "max"];

// [字段名, 展示名]：对应目录 builtinProviderModelRules[].config.properties.inputFormat。
const INPUT_FORMATS = [
  ["supportsImage", "图片"],
  ["supportsPdf", "PDF"],
  ["supportsVideo", "视频"],
  ["supportsAudio", "音频"],
];

function blankModel(upstreamModelId, prefill) {
  return {
    upstreamModelId,
    displayName: upstreamModelId,
    selected: false,
    contextWindow: prefill && prefill.contextWindow ? String(prefill.contextWindow) : "",
    maxOutputTokens: "",
    supportsImage: false,
    supportsPdf: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsToolCall: true,
    reasoningLevels:
      prefill && Array.isArray(prefill.thinkingLevels)
        ? prefill.thinkingLevels.filter((level) => THINKING_LEVELS.includes(level))
        : [],
  };
}

/** 页面的发布草稿挂在全局 state 上，切页即弃。 */
function draft() {
  if (!state.publish) {
    state.publish = {
      providers: [],
      priced: new Set(),
      capabilities: new Map(),
      settings: new Map(),
      suggestions: {},
      keepBuiltin: true,
      revision: null,
      preview: null,
    };
  }
  return state.publish;
}

function ensureProviderDraft(providerId, clientProtocol) {
  const publish = draft();
  let entry = publish.settings.get(providerId);
  if (!entry) {
    entry = { protocol: clientProtocol || "anthropic-messages", models: [] };
    publish.settings.set(providerId, entry);
  } else if (clientProtocol) {
    entry.protocol = clientProtocol;
  }
  return entry;
}

/** 已保存设置与上游列表合并成草稿：已发布的模型保持勾选与其配置。 */
function mergeSaved(savedProviders) {
  const publish = draft();
  publish.settings = new Map();
  for (const provider of publish.providers) {
    const saved = savedProviders.find((item) => item.providerId === provider.id);
    const entry = ensureProviderDraft(provider.id, saved ? saved.clientProtocol : null);
    if (!saved) continue;
    for (const model of saved.models) {
      const fresh = blankModel(model.upstreamModelId);
      fresh.selected = true;
      fresh.displayName = model.displayName;
      fresh.contextWindow = model.contextWindow === null ? "" : String(model.contextWindow);
      fresh.maxOutputTokens = model.maxOutputTokens === null ? "" : String(model.maxOutputTokens);
      fresh.supportsImage = model.supportsImage;
      fresh.supportsPdf = model.supportsPdf;
      fresh.supportsVideo = model.supportsVideo;
      fresh.supportsAudio = model.supportsAudio;
      fresh.supportsToolCall = model.supportsToolCall;
      fresh.reasoningLevels = [...(model.reasoningLevels ?? [])];
      entry.models.push(fresh);
    }
  }
}

/** 拉到的上游模型并入草稿：已发布的保持原样，新拉到的未勾选（能力用内置目录预填）。 */
function mergeFetched(providerId, fetchedIds) {
  const entry = ensureProviderDraft(providerId, null);
  const known = new Set(entry.models.map((model) => model.upstreamModelId));
  let added = 0;
  for (const id of fetchedIds) {
    if (known.has(id)) continue;
    entry.models.push(blankModel(id, draft().capabilities.get(id)));
    added += 1;
  }
  return added;
}

function buildSettingsPayload() {
  const publish = draft();
  const providers = [];
  for (const [providerId, entry] of publish.settings) {
    const models = entry.models
      .filter((model) => model.selected)
      .map((model) => ({
        upstreamModelId: model.upstreamModelId,
        displayName: model.displayName,
        contextWindow: model.contextWindow === "" ? null : Number(model.contextWindow),
        maxOutputTokens: model.maxOutputTokens === "" ? null : Number(model.maxOutputTokens),
        supportsImage: model.supportsImage,
        supportsPdf: model.supportsPdf,
        supportsVideo: model.supportsVideo,
        supportsAudio: model.supportsAudio,
        supportsToolCall: model.supportsToolCall,
        reasoningLevels: model.reasoningLevels.length > 0 ? [...model.reasoningLevels] : null,
      }));
    providers.push({ providerId, clientProtocol: entry.protocol, models });
  }
  return { providers };
}

function renderModelRows(providerId, entry) {
  const publish = draft();
  if (entry.models.length === 0) {
    return '<tr><td colspan="9" class="muted">还没有模型：点「拉取模型列表」从上游获取。</td></tr>';
  }
  const id = esc(providerId);
  // 行内控件的公共属性；每格再用 data-field 区分。
  const attrs = (index, field) =>
    'data-provider="' + id + '" data-index="' + index + '" data-field="' + field + '"';
  const check = (checked, index, field, extra) =>
    '<input type="checkbox"' +
    (checked ? " checked" : "") +
    " " +
    attrs(index, field) +
    extra +
    " />";
  const text = (index, field, value, disabled) =>
    '<input type="text" value="' + esc(value) + '" ' + attrs(index, field) + disabled + " />";
  const rows = entry.models.map((model, index) => {
    const off = model.selected ? "" : " disabled";
    const levels = THINKING_LEVELS.map(
      (level) =>
        '<label class="tiny">' +
        check(
          model.reasoningLevels.includes(level),
          index,
          "level",
          ' data-level="' + level + '"',
        ) +
        level +
        "</label>",
    ).join(" ");
    const formats = INPUT_FORMATS.map(
      (item) =>
        '<label class="tiny">' + check(model[item[0]], index, item[0], off) + item[1] + "</label>",
    ).join(" ");
    const priced = publish.priced.has(model.upstreamModelId)
      ? ""
      : ' <span class="muted">未配单价</span>';
    const move = (dir, label, blocked) =>
      '<button class="btn small" data-pub-action="move" data-dir="' +
      dir +
      '" data-provider="' +
      id +
      '" data-index="' +
      index +
      '"' +
      (blocked ? " disabled" : "") +
      ">" +
      label +
      "</button>";
    return (
      "<tr>" +
      "<td>" +
      check(model.selected, index, "selected", "") +
      "</td>" +
      "<td><code>" +
      esc(model.upstreamModelId) +
      "</code>" +
      priced +
      "</td>" +
      "<td>" +
      text(index, "displayName", model.displayName, off) +
      "</td>" +
      '<td class="actions">' +
      move("up", "↑", index === 0) +
      move("down", "↓", index === entry.models.length - 1) +
      "</td>" +
      "<td>" +
      text(index, "contextWindow", model.contextWindow, off) +
      "</td>" +
      "<td>" +
      text(index, "maxOutputTokens", model.maxOutputTokens, off) +
      "</td>" +
      "<td>" +
      formats +
      "</td>" +
      '<td><label class="tiny">' +
      check(model.supportsToolCall, index, "supportsToolCall", off) +
      "工具调用</label></td>" +
      "<td>" +
      levels +
      "</td>" +
      "</tr>"
    );
  });
  return rows.join("");
}

function renderProviderBlock(provider) {
  const publish = draft();
  const entry = ensureProviderDraft(provider.id, null);
  const suggestion = publish.suggestions[provider.id];
  const selectedCount = entry.models.filter((model) => model.selected).length;
  return (
    '<section class="section">' +
    "<h3>" +
    esc(provider.label || provider.id) +
    ' <span class="muted">（网关 id ' +
    esc(provider.id) +
    "）</span></h3>" +
    '<div class="row">' +
    '<div class="field"><label for="pub-protocol-' +
    esc(provider.id) +
    '">客户端协议</label>' +
    '<select id="pub-protocol-' +
    esc(provider.id) +
    '" data-provider="' +
    esc(provider.id) +
    '" data-field="protocol">' +
    CLIENT_PROTOCOLS.map(
      (item) =>
        '<option value="' +
        item +
        '"' +
        (entry.protocol === item ? " selected" : "") +
        ">" +
        esc(item) +
        "</option>",
    ).join("") +
    "</select></div>" +
    '<button class="btn" data-pub-action="fetch" data-provider="' +
    esc(provider.id) +
    '">拉取模型列表</button>' +
    '<span class="muted">已选 ' +
    selectedCount +
    " / " +
    entry.models.length +
    " 个模型</span>" +
    "</div>" +
    (suggestion
      ? '<div class="message warn show">上游 baseUrl 需要以 /v1 结尾。' +
        '<button class="btn small" data-pub-action="apply-suggestion" data-provider="' +
        esc(provider.id) +
        '">一键改为 ' +
        esc(suggestion) +
        "</button></div>"
      : "") +
    "<table><thead><tr><th>发布</th><th>上游模型 ID</th><th>显示名（客户端展示与请求都用它）</th>" +
    "<th>顺序</th><th>上下文窗口</th><th>输出上限</th><th>输入格式</th><th>工具</th><th>思考等级</th></tr></thead>" +
    "<tbody>" +
    renderModelRows(provider.id, entry) +
    "</tbody></table>" +
    "</section>"
  );
}

function render() {
  const publish = draft();
  const blocks = publish.providers.map(renderProviderBlock).join("");
  const preview = publish.preview;
  el("panel").innerHTML =
    '<div id="publish-root">' +
    '<section class="section"><h2>模型发布</h2>' +
    '<p class="muted">勾选模型并编辑<strong>显示名</strong>后保存，再「推送到客户端」。' +
    "显示名就是客户端里展示与请求所用的模型 ID（可与上游 ID 不同），网关会把它改写回真实模型 ID 并计量计费；" +
    "同一上游内显示名不能重复。思考档位不勾任何项时走客户端内置兜底。目录里不含上游 API key。</p>" +
    (publish.revision === null
      ? ""
      : '<p class="muted">当前目录 revision：' +
        esc(publish.revision) +
        "（客户端只接受更大的 revision）</p>") +
    "</section>" +
    (publish.providers.length === 0
      ? '<section class="section"><span class="muted">还没有上游。请先在「上游」页配置 provider。</span></section>'
      : blocks) +
    '<section class="section"><h2>生成与推送</h2>' +
    '<div class="row">' +
    '<label class="tiny"><input type="checkbox" id="publish-keep-builtin"' +
    (publish.keepBuiltin ? " checked" : "") +
    " />保留内置 provider</label>" +
    '<button class="btn" id="publish-save">保存设置</button>' +
    '<button class="btn" id="publish-preview">预览目录</button>' +
    '<button class="btn primary" id="publish-apply">推送到客户端</button>' +
    "</div>" +
    '<div id="publish-message" class="message"></div>' +
    (preview
      ? "<h3>预览（revision " +
        esc(preview.revision) +
        "：provider " +
        esc(preview.summary.providerCount) +
        " 个 / 模型 " +
        esc(preview.summary.modelCount) +
        " 条）</h3>" +
        '<textarea id="publish-preview-json" spellcheck="false" readonly>' +
        esc(preview.content) +
        "</textarea>"
      : "") +
    "</section></div>";

  const root = el("publish-root");
  root.addEventListener("click", handleRootClick);
  root.addEventListener("change", handleRootChange);
  root.addEventListener("input", handleRootInput);
  el("publish-save").onclick = () => void saveSettings();
  el("publish-preview").onclick = () => void requestCatalog(true);
  el("publish-apply").onclick = () => {
    if (
      !window.confirm("推送到客户端？所有在线客户端（最长约 1 分钟）会应用新目录，确认要推送吗？")
    )
      return;
    void requestCatalog(false);
  };
  el("publish-keep-builtin").addEventListener("change", (event) => {
    draft().keepBuiltin = event.target.checked;
  });
}

function handleRootClick(event) {
  const target = event.target;
  const action = target && target.dataset ? target.dataset.pubAction : null;
  if (!action) return;
  const providerId = target.dataset.provider;
  if (action === "fetch") {
    fetchModels(providerId);
    return;
  }
  if (action === "apply-suggestion") {
    applySuggestion(providerId);
    return;
  }
  if (action === "move") {
    const entry = ensureProviderDraft(providerId, null);
    const index = Number(target.dataset.index);
    const swapWith = target.dataset.dir === "up" ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= entry.models.length) return;
    const models = entry.models;
    [models[index], models[swapWith]] = [models[swapWith], models[index]];
    render();
  }
}

function handleRootChange(event) {
  const target = event.target;
  const field = target && target.dataset ? target.dataset.field : null;
  if (!field) return;
  if (field === "protocol") {
    ensureProviderDraft(target.dataset.provider, target.value);
    return;
  }
  const entry = ensureProviderDraft(target.dataset.provider, null);
  const model = entry.models[Number(target.dataset.index)];
  if (!model) return;
  if (field === "selected") {
    model.selected = target.checked;
    render();
  } else if (field === "level") {
    if (target.checked && !model.reasoningLevels.includes(target.dataset.level)) {
      model.reasoningLevels.push(target.dataset.level);
    } else if (!target.checked) {
      model.reasoningLevels = model.reasoningLevels.filter((item) => item !== target.dataset.level);
    }
  } else if (field === "supportsToolCall" || INPUT_FORMATS.some((item) => item[0] === field)) {
    model[field] = target.checked;
  }
}

function handleRootInput(event) {
  const target = event.target;
  const field = target && target.dataset ? target.dataset.field : null;
  if (!field) return;
  if (field !== "displayName" && field !== "contextWindow" && field !== "maxOutputTokens") return;
  const entry = ensureProviderDraft(target.dataset.provider, null);
  const model = entry.models[Number(target.dataset.index)];
  if (model) model[field] = target.value;
}

function fetchModels(providerId) {
  showMessage("publish-message", "正在拉取模型列表…", "warn");
  api("/api/admin/providers/" + encodeURIComponent(providerId) + "/fetch-models", {
    method: "POST",
  })
    .then((body) => {
      const added = mergeFetched(providerId, body.models);
      if (body.suggestedBaseUrl) draft().suggestions[providerId] = body.suggestedBaseUrl;
      showMessage(
        "publish-message",
        "拉到 " + body.models.length + " 个模型，新加入 " + added + " 个（默认未勾选）",
        "ok",
      );
      render();
    })
    .catch((error) => showMessage("publish-message", error.message, "error"));
}

/** 上游 baseUrl 缺 /v1 时的一键修正：复用「上游」页的 PUT /providers/:id。 */
function applySuggestion(providerId) {
  const publish = draft();
  const suggestion = publish.suggestions[providerId];
  const provider = publish.providers.find((item) => item.id === providerId);
  if (!suggestion || !provider) return;
  api("/api/admin/providers/" + encodeURIComponent(providerId), {
    method: "PUT",
    body: JSON.stringify({
      label: provider.label,
      upstreamBaseUrl: suggestion,
      protocol: provider.protocol,
      apiKey: "",
      enabled: true,
    }),
  })
    .then(() => {
      provider.upstreamBaseUrl = suggestion;
      delete publish.suggestions[providerId];
      showMessage("publish-message", "上游 baseUrl 已更新为 " + suggestion, "ok");
      render();
    })
    .catch((error) => showMessage("publish-message", error.message, "error"));
}

function saveSettings() {
  return api("/api/admin/publish", { method: "PUT", body: JSON.stringify(buildSettingsPayload()) })
    .then((saved) => {
      const count = saved.providers.reduce((total, provider) => total + provider.models.length, 0);
      showMessage(
        "publish-message",
        "设置已保存（" + count + " 个模型）。预览或推送到客户端才会生效。",
        "ok",
      );
      return saved;
    })
    .catch((error) => showMessage("publish-message", error.message, "error"));
}

/** 保存后按 keepBuiltin 请求生成；preview=true 只预览，否则推送并返回新 revision。 */
function requestCatalog(preview) {
  return saveSettings()
    .then(() =>
      api("/api/admin/publish/" + (preview ? "preview" : "apply"), {
        method: "POST",
        body: JSON.stringify({ keepBuiltinProviders: draft().keepBuiltin }),
      }),
    )
    .then((result) => {
      if (preview) {
        draft().preview = result;
      } else {
        draft().revision = result.revision;
        draft().preview = null;
        showMessage(
          "publish-message",
          "已推送，revision " + result.revision + "。客户端约 1 分钟内生效。",
          "ok",
        );
      }
      render();
    })
    .catch((error) => showMessage("publish-message", error.message, "error"));
}

function renderPublish() {
  const publish = draft();
  publish.preview = null;
  return Promise.all([
    api("/api/admin/providers"),
    api("/api/admin/publish"),
    api("/api/admin/prices"),
    api("/api/admin/catalog/builtin"),
    api("/api/admin/catalog"),
  ]).then((results) => {
    publish.providers = results[0].providers;
    publish.priced = new Set(results[2].prices.map((price) => price.modelId));
    publish.revision = results[4].revision;
    const builtin = results[3].builtin;
    publish.capabilities = new Map();
    if (builtin && Array.isArray(builtin.capabilities)) {
      for (const item of builtin.capabilities) publish.capabilities.set(item.modelId, item);
    }
    mergeSaved(results[1].providers || []);
    render();
  });
}

// 注册本页：queueMicrotask 等 app.js 的 SCREENS 完成初始化（见 screens-users.js 头注释）。
queueMicrotask(() => registerScreen("publish", renderPublish));
