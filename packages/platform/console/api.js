/**
 * 管理后台的共享基础设施：登录令牌、请求封装、格式化与提示。
 *
 * 用浏览器原生 ES 模块，不引入构建步骤：整个 console 目录直接复制进容器镜像即可。
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
  ["prices", "单价"],
  ["plans", "套餐"],
  ["releases", "客户端发布"],
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

export function api(path, options) {
  const init = options || {};
  const headers = Object.assign({}, init.headers || {});
  if (init.body !== undefined && !(init.body instanceof Blob)) {
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
