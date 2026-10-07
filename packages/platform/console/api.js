/**
 * 管理后台的共享基础设施：登录令牌、请求封装、格式化、弹层、分页与提示。
 *
 * 用浏览器原生 ES 模块，不引入构建步骤：整个 console 目录直接复制进容器镜像即可。
 * 页面渲染器通过 app.js 的 registerScreen 注册；各页面之间不互相依赖。
 */
const TOKEN_KEY = "zcode_platform_console_token";

let token = sessionStorage.getItem(TOKEN_KEY) || "";

/** 跨文件共享的界面状态。 */
export const state = {
  tab: "dashboard",
  userDetailId: null,
  plans: [],
  users: [],
  providers: [],
};

export const TABS = [
  ["dashboard", "概览"],
  ["users", "用户"],
  ["catalog", "模型目录"],
  ["providers", "上游"],
  ["publish", "模型发布"],
  ["prices", "单价"],
  ["plans", "套餐"],
  ["releases", "客户端发布"],
  ["operations", "运营"],
];

export function getToken() {
  return token;
}

export function setToken(value) {
  token = value || "";
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
  } else {
    sessionStorage.removeItem(TOKEN_KEY);
  }
}

export function el(id) {
  return document.getElementById(id);
}

export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function toast(text, isError) {
  const node = el("toast");
  node.textContent = text;
  node.className = "toast" + (isError ? " error" : "");
  window.setTimeout(() => {
    node.className = "toast hidden";
  }, 3200);
}

export function showMessage(targetId, text, kind) {
  const node = el(targetId);
  if (!node) return;
  node.textContent = text || "";
  node.className = "message" + (text ? " show " + (kind || "ok") : "");
}

export function fmtMicros(micros) {
  if (typeof micros !== "number") return "-";
  const negative = micros < 0;
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / 1000000);
  const fraction = String(abs % 1000000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return (negative ? "-" : "") + whole + (fraction ? "." + fraction : "");
}

export function fmtTime(ms) {
  if (!ms) return "-";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    // 无效时间戳不该让整页渲染失败，退回原值展示即可。
    return String(ms);
  }
}

export function fmtBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (unit === 0 ? value : value.toFixed(1)) + " " + units[unit];
}

export function fmtTokens(tokens) {
  if (!tokens) return "0";
  return (
    "入 " +
    (tokens.inputTokens || 0) +
    " / 出 " +
    (tokens.outputTokens || 0) +
    " / 缓存读 " +
    (tokens.cacheReadTokens || 0) +
    " / 缓存写 " +
    (tokens.cacheWriteTokens || 0)
  );
}

export function metric(label, value) {
  return (
    '<div class="metric"><div class="metric-label">' +
    esc(label) +
    '</div><div class="metric-value">' +
    esc(value) +
    "</div></div>"
  );
}

export function field(id, label, type) {
  return (
    '<div class="field"><label for="' +
    id +
    '">' +
    esc(label) +
    '</label><input id="' +
    id +
    '" type="' +
    esc(type) +
    '" /></div>'
  );
}

/**
 * 服务端分页控件。onPage 收到新的 offset；服务端必须返回 { total }。
 * 有上限提示：total 超过当前页窗口时才显示翻页按钮。
 */
export function renderPagination(total, limit, offset, onPage) {
  if (!total || total <= limit) return "";
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  const button = (targetOffset, label, disabled, isCurrent) =>
    '<button class="btn small' +
    (isCurrent ? " primary" : "") +
    '" data-page-offset="' +
    targetOffset +
    '"' +
    (disabled ? " disabled" : "") +
    ">" +
    label +
    "</button>";
  const html =
    '<div class="pagination" data-pagination="1">' +
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
    "</div>";
  // 事件委托交给调用方的 panel；这里用全局一次性监听即可（同一个节点会随 innerHTML 重建）。
  window.requestAnimationFrame(() => {
    const box = document.querySelector(".pagination[data-pagination]");
    if (box && !box.dataset.bound) {
      box.dataset.bound = "1";
      box.addEventListener("click", (event) => {
        const target = event.target;
        if (target && target.dataset && target.dataset.pageOffset !== undefined) {
          const next = Number(target.dataset.pageOffset);
          if (!target.disabled && next !== offset) onPage(next);
        }
      });
    }
  });
  return html;
}

export function api(path, options) {
  const init = options || {};
  const headers = Object.assign({}, init.headers || {});
  if (init.body !== undefined && !(init.body instanceof Blob) && !(init.body instanceof File)) {
    headers["content-type"] = "application/json";
  }
  if (token) headers.authorization = "Bearer " + token;
  init.headers = headers;
  return fetch(path, init).then((response) => {
    if (response.status === 204) return null;
    return response.text().then((text) => {
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          // 非 JSON 响应（如静态资源）按空体处理。
          body = null;
        }
      }
      if (!response.ok) {
        const message =
          body && body.error ? body.error.message : "请求失败（" + response.status + "）";
        const failure = new Error(message);
        failure.status = response.status;
        failure.code = body && body.error ? body.error.code : null;
        throw failure;
      }
      return body;
    });
  });
}

/** 登录态失效时清掉令牌并回到登录页；返回 true 表示已经处理过。 */
export function handleAuthFailure(error, onSignedOut) {
  if (error && (error.status === 401 || error.status === 403)) {
    setToken("");
    onSignedOut();
    return true;
  }
  return false;
}

// ── 通用弹层 ────────────────────────────────────────────────
// 用受控的 modal 替代 window.prompt/confirm：密码不明文回显、支持多字段表单、
// 外观与全站一致。showModal 一次性挂回调，取消时回调不执行。

let modalActive = null;

/**
 * 打开弹层。
 * options: { title, text?, fields?: [{id,label,type,value,placeholder,required}], okLabel?, danger? }
 * 返回一个 Promise：确定时解析为 { values: {fieldId: value} }，取消时解析为 null。
 */
export function showModal(options) {
  return new Promise((resolve) => {
    const backdrop = el("modal-backdrop");
    modalActive = { resolve };
    el("modal-title").textContent = options.title || "";
    el("modal-text").textContent = options.text || "";
    el("modal-text").style.display = options.text ? "" : "none";
    el("modal-message").textContent = "";
    el("modal-message").className = "message";
    const okButton = el("modal-ok");
    okButton.textContent = options.okLabel || "确定";
    okButton.className = "btn" + (options.danger ? " danger" : " primary");
    const fieldsHtml = (options.fields || [])
      .map((item) => {
        const value = item.value === undefined || item.value === null ? "" : String(item.value);
        return (
          '<div class="field"><label for="modal-field-' +
          esc(item.id) +
          '">' +
          esc(item.label) +
          '</label><input id="modal-field-' +
          esc(item.id) +
          '" type="' +
          esc(item.type || "text") +
          '" value="' +
          esc(value) +
          '"' +
          (item.placeholder ? ' placeholder="' + esc(item.placeholder) + '"' : "") +
          " /></div>"
        );
      })
      .join("");
    el("modal-fields").innerHTML = fieldsHtml;
    backdrop.className = "modal-backdrop";
    const first = el("modal-fields").querySelector("input");
    if (first) {
      window.requestAnimationFrame(() => first.focus());
    } else {
      window.requestAnimationFrame(() => okButton.focus());
    }
  });
}

function settleModal(result) {
  if (!modalActive) return;
  const current = modalActive;
  modalActive = null;
  el("modal-backdrop").className = "modal-backdrop hidden";
  current.resolve(result);
}

export function closeModal() {
  settleModal(null);
}

/** 弹层里读取字段值；供 ok 回调用。 */
export function modalValue(fieldId) {
  const node = el("modal-field-" + fieldId);
  return node ? node.value : "";
}

export function modalMessage(text, kind) {
  showMessage("modal-message", text, kind);
}

/** 初始化弹层的固定事件绑定；app.js 启动时调用一次。 */
export function setupModal() {
  el("modal-cancel").addEventListener("click", () => settleModal(null));
  el("modal-backdrop").addEventListener("click", (event) => {
    if (event.target === el("modal-backdrop")) settleModal(null);
  });
  document.addEventListener("keydown", (event) => {
    if (modalActive && event.key === "Escape") settleModal(null);
  });
  el("modal-ok").addEventListener("click", () => {
    if (!modalActive) return;
    // ok 的语义由打开方在 Promise 链里处理：这里只负责收值并关窗。
    const fields = {};
    for (const node of el("modal-fields").querySelectorAll("input")) {
      fields[node.id.replace("modal-field-", "")] = node.value;
    }
    settleModal({ values: fields });
  });
}

/** 便捷封装：确认对话（替代 window.confirm）。返回 true=确认。 */
export function confirmModal(title, text, okLabel) {
  return showModal({ title, text, okLabel: okLabel || "确认", danger: true }).then(
    (result) => result !== null,
  );
}

/** 便捷封装：单字段输入（替代 window.prompt）。返回输入值或 null。 */
export function promptModal(title, text, fieldSpec) {
  return showModal({
    title,
    text,
    fields: fieldSpec ? [fieldSpec] : [],
    okLabel: "确定",
  }).then((result) => (result === null ? null : result.values[fieldSpec.id]));
}
