/**
 * 管理后台：运营页（系统设置、兑换码、审计日志、用户 API Key）。
 *
 * 语义口径见 specs/platform/operations.md：服务端是唯一校验者，本页只做展示与提交；
 * 所有写操作由服务端记审计。敏感结果（兑换码明文、API Key 明文）只在弹层显示一次。
 * 吊销类动作复用 app.js 的全局委托（delete-redeem / revoke-apikey），本页不重复绑定。
 */
import { registerScreen } from "./app.js";
import { api, el, esc, field, fmtTime, renderPagination, showMessage, showModal } from "./api.js";

const AUDIT_PAGE_SIZE = 50;

/** 兑换码状态前端判定：吊销优先，其次按过期时间与当前时间比较。 */
function redeemStatus(code) {
  if (code.revokedAt) return ["已吊销", "danger"];
  if (code.expiresAt !== null && code.expiresAt <= Date.now()) return ["已过期", "danger"];
  return ["有效", "ok"];
}

/**
 * 在弹层的 fields 区注入一次性明文列表（兑换码 / API Key 共用）。
 * showModal 对无字段表单只同步清空 #modal-fields 后返回 Promise，
 * 这里在其后立即写入自定义内容；确定按钮收值时只读 input，不受影响。
 */
function showSecretModal(title, text, lines) {
  const shown = showModal({ title, text, okLabel: "我已保存" });
  el("modal-fields").innerHTML = lines;
  return shown;
}

// ── a) 系统设置 ─────────────────────────────────────────────

function renderSettingsSection(settings) {
  return (
    '<section class="section"><h2>系统设置</h2>' +
    '<p class="muted">最低可用版本写入客户端 /client/configs 的 ' +
    "<code>configs.forceUpdate.minimalVersion</code>：版本号低于它的客户端在启动时会强制更新，" +
    "留空表示不启用。允许兑换码自助注册目前为预留开关。</p>" +
    '<div class="row">' +
    '<div class="field"><label for="settings-min-version">最低可用版本（如 3.15.0，留空不启用）</label>' +
    '<input id="settings-min-version" type="text" value="' +
    esc(settings.forceUpdateMinimalVersion) +
    '" /></div>' +
    '<div class="field"><label for="settings-self-register">自助注册</label>' +
    '<label class="check"><input id="settings-self-register" type="checkbox"' +
    (settings.allowSelfRegistration ? " checked" : "") +
    " /> 允许兑换码自助注册</label></div>" +
    '<button class="btn primary" id="save-settings">保存设置</button>' +
    "</div>" +
    '<div id="settings-message" class="message"></div></section>'
  );
}

function bindSettingsSection() {
  el("save-settings").onclick = () => {
    // 全量提交两字段：后端按字段存在与否更新，缺字段会被当作「不修改」。
    api("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({
        forceUpdateMinimalVersion: el("settings-min-version").value.trim(),
        allowSelfRegistration: el("settings-self-register").checked,
      }),
    })
      .then(() => {
        showMessage("settings-message", "设置已保存", "ok");
      })
      .catch((error) => showMessage("settings-message", error.message, "error"));
  };
}

// ── b) 兑换码 ───────────────────────────────────────────────

function renderRedeemSection(codes) {
  const rows = codes
    .map((code) => {
      const status = redeemStatus(code);
      return (
        "<tr><td>" +
        '<span class="mono">' +
        esc(code.code) +
        "</span></td><td>" +
        esc(code.amount) +
        "</td><td>" +
        esc(code.redeemedCount) +
        " / " +
        esc(code.maxRedemptions) +
        "</td><td>" +
        (code.expiresAt === null
          ? '<span class="muted">永久</span>'
          : esc(fmtTime(code.expiresAt))) +
        '</td><td><span class="badge ' +
        status[1] +
        '">' +
        status[0] +
        "</span></td><td>" +
        esc(fmtTime(code.createdAt)) +
        '</td><td class="actions">' +
        (code.revokedAt
          ? '<span class="muted">-</span>'
          : '<button class="btn small danger" data-action="delete-redeem" data-id="' +
            esc(code.id) +
            '">吊销</button>') +
        "</td></tr>"
      );
    })
    .join("");

  return (
    '<section class="section"><h2>兑换码</h2>' +
    '<p class="muted">用户在客户端兑换后按面额入余额；吊销后不能再核销，已核销的入账保留。' +
    "明文码只在生成结果弹层显示一次。</p>" +
    '<div class="row">' +
    field("redeem-count", "生成数量（1..50）", "number") +
    field("redeem-amount", "面额（如 50）", "text") +
    field("redeem-max", "每人限领次数（默认 1）", "number") +
    field("redeem-expires", "过期时间（留空永久）", "datetime-local") +
    '<button class="btn primary" id="create-redeem">生成</button>' +
    "</div>" +
    '<div id="redeem-message" class="message"></div>' +
    (codes.length === 0
      ? '<p class="muted">还没有兑换码。</p>'
      : '<div class="table-scroll"><table><thead><tr><th>码</th><th>面额</th><th>已核销 / 上限</th><th>过期</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>' +
        rows +
        "</tbody></table></div>") +
    "</section>"
  );
}

function bindRedeemSection() {
  el("create-redeem").onclick = () => {
    const count = Number(el("redeem-count").value);
    const amount = el("redeem-amount").value.trim();
    const maxRaw = el("redeem-max").value.trim();
    const expiresRaw = el("redeem-expires").value; // datetime-local，如 2026-01-01T08:00
    if (!amount) {
      showMessage("redeem-message", "面额不能为空", "error");
      return;
    }
    if (!Number.isSafeInteger(count) || count < 1 || count > 50) {
      showMessage("redeem-message", "生成数量必须是 1..50 的整数", "error");
      return;
    }
    // 后端把 expiresAt 当字符串读取后转数字：传毫秒时间戳，留空表示永久。
    const expiresAt = expiresRaw ? String(new Date(expiresRaw).getTime()) : "";
    api("/api/admin/redeem-codes", {
      method: "POST",
      body: JSON.stringify({
        count,
        amount,
        maxRedemptions: maxRaw ? Number(maxRaw) : 1,
        expiresAt,
      }),
    })
      .then((body) => {
        showMessage("redeem-message", "已生成 " + body.codes.length + " 个兑换码", "ok");
        // 明文只显示这一次；copy-text 由 app.js 全局委托处理。
        const lines = body.codes
          .map(
            (code) =>
              '<div class="row"><span class="mono">' +
              esc(code.code) +
              '</span><button class="btn small" data-action="copy-text" data-copy-value="' +
              esc(code.code) +
              '">复制</button></div>',
          )
          .join("");
        showSecretModal(
          "已生成 " + body.codes.length + " 个兑换码（只显示一次）",
          "请复制并妥善保存，关闭后无法再次查看。",
          lines,
        );
      })
      .catch((error) => showMessage("redeem-message", error.message, "error"));
  };
}

// ── c) 审计日志 ─────────────────────────────────────────────

function renderAuditSection(entries, total, action, offset) {
  const rows = entries
    .map(
      (entry) =>
        "<tr><td>" +
        esc(fmtTime(entry.createdAt)) +
        "</td><td>" +
        '<span class="mono">' +
        esc(entry.actorUserId || "-") +
        "</span></td><td>" +
        '<span class="mono">' +
        esc(entry.action) +
        "</span></td><td>" +
        esc(entry.targetType || "-") +
        (entry.targetId
          ? ' <span class="muted mono">' +
            esc(entry.targetId.length > 16 ? entry.targetId.slice(0, 16) + "…" : entry.targetId) +
            "</span>"
          : "") +
        "</td><td>" +
        (entry.detail
          ? '<details><summary class="muted">详情</summary><pre class="mono">' +
            esc(entry.detail) +
            "</pre></details>"
          : '<span class="muted">-</span>') +
        "</td></tr>",
    )
    .join("");

  return (
    '<section class="section" id="audit-section"><h2>审计日志 <span class="muted">共 ' +
    total +
    " 条</span></h2>" +
    '<p class="muted">按动作精确过滤（如 <code>settings.update</code>），留空查看全部。</p>' +
    '<div class="row">' +
    field("audit-action", "动作（精确匹配，留空全部）", "text") +
    '<button class="btn primary" id="audit-query">查询</button>' +
    "</div>" +
    '<div id="audit-message" class="message"></div>' +
    (entries.length === 0
      ? '<p class="muted">没有匹配的审计记录。</p>'
      : '<div class="table-scroll"><table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>目标</th><th>详情</th></tr></thead><tbody>' +
        rows +
        "</tbody></table></div>") +
    renderPagination(total, AUDIT_PAGE_SIZE, offset, (next) => loadAudit(action, next)) +
    "</section>"
  );
}

function loadAudit(action, offset) {
  const query =
    "?limit=" +
    AUDIT_PAGE_SIZE +
    "&offset=" +
    offset +
    (action ? "&action=" + encodeURIComponent(action) : "");
  api("/api/admin/audit" + query)
    .then((body) => {
      // 只替换审计 section，避免打断上方设置/兑换码区域的输入状态。
      const section = el("audit-section");
      if (!section) return;
      section.outerHTML = renderAuditSection(body.entries, body.total, action, offset);
      bindAuditSection();
    })
    .catch((error) => showMessage("audit-message", error.message, "error"));
}

function bindAuditSection() {
  el("audit-query").onclick = () => {
    loadAudit(el("audit-action").value.trim(), 0);
  };
}

// ── d) 用户 API Key（全站）─────────────────────────────────

function renderApiKeysSection(keys) {
  const rows = keys
    .map(
      (key) =>
        "<tr><td>" +
        '<span class="mono">' +
        esc(key.keyHint) +
        "</span></td><td>" +
        '<span class="mono">' +
        esc(key.userId) +
        "</span></td><td>" +
        esc(key.name || "-") +
        "</td><td>" +
        esc(fmtTime(key.createdAt)) +
        "</td><td>" +
        esc(fmtTime(key.lastUsedAt)) +
        '</td><td><span class="badge ' +
        (key.revokedAt ? "danger" : "ok") +
        '">' +
        (key.revokedAt ? "已吊销" : "有效") +
        '</span></td><td class="actions">' +
        (key.revokedAt
          ? '<span class="muted">-</span>'
          : '<button class="btn small danger" data-action="revoke-apikey" data-id="' +
            esc(key.id) +
            '">吊销</button>') +
        "</td></tr>",
    )
    .join("");

  return (
    '<section class="section"><h2>用户 API Key（全站）</h2>' +
    '<p class="muted">全站视角查看与吊销；明文只在生成时显示一次，列表里只保留末四位 hint。</p>' +
    '<div class="row">' +
    field("apikey-user-id", "所属用户 id", "text") +
    field("apikey-name", "名称（可选）", "text") +
    '<button class="btn primary" id="create-apikey">生成</button>' +
    "</div>" +
    '<div id="apikey-message" class="message"></div>' +
    (keys.length === 0
      ? '<p class="muted">还没有任何 API Key。</p>'
      : '<div class="table-scroll"><table><thead><tr><th>Key</th><th>所属用户</th><th>名称</th><th>创建</th><th>最近使用</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
        rows +
        "</tbody></table></div>") +
    "</section>"
  );
}

function bindApiKeysSection() {
  el("create-apikey").onclick = () => {
    const userId = el("apikey-user-id").value.trim();
    if (!userId) {
      showMessage("apikey-message", "所属用户 id 不能为空", "error");
      return;
    }
    api("/api/admin/api-keys", {
      method: "POST",
      body: JSON.stringify({ userId, name: el("apikey-name").value }),
    })
      .then((body) => {
        showMessage("apikey-message", "已生成 API Key", "ok");
        // 明文只显示一次；copy-text 由 app.js 全局委托处理。
        showSecretModal(
          "API Key 已生成（只显示一次）",
          "请复制并妥善保存，关闭后无法再次查看。",
          '<div class="row"><span class="mono">' +
            esc(body.plaintext) +
            '</span><button class="btn small" data-action="copy-text" data-copy-value="' +
            esc(body.plaintext) +
            '">复制</button></div>',
        );
      })
      .catch((error) => showMessage("apikey-message", error.message, "error"));
  };
}

// ── 运营页入口 ─────────────────────────────────────────────

export function renderOperations() {
  return Promise.all([
    api("/api/admin/settings"),
    api("/api/admin/redeem-codes"),
    api("/api/admin/audit?limit=" + AUDIT_PAGE_SIZE + "&offset=0"),
    api("/api/admin/api-keys"),
  ]).then((results) => {
    const settings = results[0].settings;
    const codes = results[1].codes;
    const auditBody = results[2];
    const keys = results[3].keys;

    el("panel").innerHTML =
      renderSettingsSection(settings) +
      renderRedeemSection(codes) +
      renderAuditSection(auditBody.entries, auditBody.total, "", 0) +
      renderApiKeysSection(keys);

    bindSettingsSection();
    bindRedeemSection();
    bindAuditSection();
    bindApiKeysSection();
  });
}

// 按入口的屏幕注册表挂载；queueMicrotask 等 app.js 的 SCREENS 初始化完成（循环导入 TDZ）。
queueMicrotask(() => registerScreen("operations", renderOperations));
