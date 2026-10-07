/** 管理后台：用户列表与用户详情（余额、流水、套餐、调用记录）。 */
import {
  api,
  el,
  esc,
  field,
  fmtMicros,
  fmtTime,
  fmtTokens,
  metric,
  showMessage,
  state,
} from "./api.js";

let rerender = () => {};

export function configureUserScreens(options) {
  rerender = options.rerender;
}

export function renderUsers() {
  return Promise.all([api("/api/admin/users?limit=200"), api("/api/admin/plans")]).then(
    (results) => {
      state.users = results[0].users;
      state.plans = results[1].plans;
      const rows = state.users
        .map(
          (user) =>
            "<tr><td>" +
            esc(user.email) +
            "</td><td>" +
            esc(user.displayName) +
            "</td><td>" +
            esc(user.role) +
            "</td><td>" +
            esc(user.status) +
            "</td><td>" +
            esc(fmtMicros(user.balanceMicros)) +
            "</td><td>" +
            esc(fmtMicros(user.availableMicros)) +
            "</td><td>" +
            esc(user.planName || "-") +
            (user.planRemainingMicros !== null
              ? ' <span class="muted">剩 ' + esc(fmtMicros(user.planRemainingMicros)) + "</span>"
              : "") +
            '</td><td class="actions">' +
            '<button class="btn small" data-action="detail" data-id="' +
            esc(user.id) +
            '">详情</button>' +
            '<button class="btn small" data-action="toggle-status" data-id="' +
            esc(user.id) +
            '" data-status="' +
            esc(user.status) +
            '">' +
            (user.status === "active" ? "停用" : "启用") +
            "</button>" +
            '<button class="btn small" data-action="reset-password" data-id="' +
            esc(user.id) +
            '">重置密码</button>' +
            "</td></tr>",
        )
        .join("");

      el("panel").innerHTML =
        '<section class="section"><h2>新建用户</h2>' +
        '<div class="row">' +
        field("new-email", "邮箱", "email") +
        field("new-password", "初始密码（至少 8 位）", "text") +
        field("new-name", "显示名（可选）", "text") +
        '<div class="field"><label for="new-role">角色</label><select id="new-role">' +
        '<option value="user">user</option><option value="admin">admin</option></select></div>' +
        '<button class="btn primary" id="create-user">创建</button></div>' +
        '<div id="create-user-message" class="message"></div></section>' +
        '<section class="section"><h2>用户列表 <span class="muted">共 ' +
        results[0].total +
        ' 个</span></h2>' +
        (state.users.length === 0
          ? '<span class="muted">还没有用户。</span>'
          : '<table><thead><tr><th>邮箱</th><th>显示名</th><th>角色</th><th>状态</th>' +
            "<th>余额</th><th>可用</th><th>套餐</th><th>操作</th></tr></thead><tbody>" +
            rows +
            "</tbody></table>") +
        "</section>" +
        (state.userDetailId ? '<section class="section" id="user-detail"></section>' : "");

      el("create-user").onclick = () => {
        api("/api/admin/users", {
          method: "POST",
          body: JSON.stringify({
            email: el("new-email").value,
            password: el("new-password").value,
            displayName: el("new-name").value || undefined,
            role: el("new-role").value,
          }),
        })
          .then(() => {
            showMessage("create-user-message", "创建成功", "ok");
            rerender();
          })
          .catch((error) => {
            showMessage("create-user-message", error.message, "error");
          });
      };
    },
  );
}

export function openUserDetail(userId) {
  state.userDetailId = userId;
  renderUsers()
    .then(() => renderUserDetail(userId))
    .catch((error) => {
      showMessage("user-detail", error.message, "error");
    });
}

export function renderUserDetail(userId) {
  return Promise.all([
    api("/api/admin/users/" + encodeURIComponent(userId)),
    api("/api/admin/users/" + encodeURIComponent(userId) + "/ledger?limit=20"),
    api("/api/admin/users/" + encodeURIComponent(userId) + "/usage?limit=20"),
    api("/api/admin/plans"),
  ]).then((results) => {
    const detail = results[0];
    const ledger = results[1];
    const usage = results[2];
    state.plans = results[3].plans;
    const container = el("user-detail");
    if (!container) return;

    const planOptions = state.plans
      .map(
        (plan) =>
          '<option value="' +
          esc(plan.id) +
          '">' +
          esc(plan.name) +
          "（额度 " +
          esc(plan.quota) +
          "）</option>",
      )
      .join("");

    container.innerHTML =
      "<h2>" +
      esc(detail.user.email) +
      ' <span class="muted">' +
      esc(detail.user.id) +
      "</span></h2>" +
      '<div class="metrics">' +
      metric("余额", detail.balance.balance) +
      metric("可用余额", detail.balance.available) +
      metric("冻结（预扣中）", fmtMicros(detail.balance.reservedMicros)) +
      metric("当前套餐", detail.plan ? detail.plan.name : "无") +
      metric(
        "套餐剩余额度",
        detail.subscription ? fmtMicros(detail.subscription.remainingMicros) : "-",
      ) +
      "</div>" +
      "<h3>充值与调整</h3>" +
      '<div class="row">' +
      field("recharge-amount", "充值金额（如 10 或 10.5）", "text") +
      '<button class="btn primary" id="do-recharge">充值</button>' +
      field("adjust-amount", "调整金额（可负数，如 -5）", "text") +
      field("adjust-note", "备注", "text") +
      '<button class="btn" id="do-adjust">调整</button>' +
      '<button class="btn" id="do-reconcile">对账</button>' +
      "</div>" +
      '<div id="billing-message" class="message"></div>' +
      "<h3>套餐</h3>" +
      '<div class="row">' +
      '<div class="field"><label for="grant-plan">发放套餐</label><select id="grant-plan">' +
      (planOptions || '<option value="">（还没有套餐）</option>') +
      "</select></div>" +
      '<button class="btn primary" id="do-grant">发放</button>' +
      '<button class="btn danger" id="do-revoke">撤销当前套餐</button>' +
      "</div>" +
      '<div id="plan-message" class="message"></div>' +
      "<h3>最近流水</h3>" +
      renderLedgerTable(ledger.entries) +
      '<h3>最近调用 <span class="muted">' +
      fmtTokens(usage.totals) +
      "，消费 " +
      esc(fmtMicros(usage.totals.costMicros)) +
      "</span></h3>" +
      renderUsageTable(usage.records);

    el("do-recharge").onclick = () => {
      api("/api/admin/users/" + encodeURIComponent(userId) + "/recharge", {
        method: "POST",
        body: JSON.stringify({ amount: el("recharge-amount").value }),
      })
        .then(() => {
          showMessage("billing-message", "充值成功", "ok");
          openUserDetail(userId);
        })
        .catch((error) => showMessage("billing-message", error.message, "error"));
    };

    el("do-adjust").onclick = () => {
      api("/api/admin/users/" + encodeURIComponent(userId) + "/adjust", {
        method: "POST",
        body: JSON.stringify({
          delta: el("adjust-amount").value,
          note: el("adjust-note").value,
        }),
      })
        .then(() => {
          showMessage("billing-message", "调整成功", "ok");
          openUserDetail(userId);
        })
        .catch((error) => showMessage("billing-message", error.message, "error"));
    };

    el("do-reconcile").onclick = () => {
      api("/api/admin/users/" + encodeURIComponent(userId) + "/reconcile")
        .then((result) => {
          showMessage(
            "billing-message",
            result.consistent
              ? "账目一致：" + fmtMicros(result.storedMicros)
              : "账目不一致！余额 " +
                  fmtMicros(result.storedMicros) +
                  "，流水合计 " +
                  fmtMicros(result.recomputedMicros) +
                  "，差异 " +
                  fmtMicros(result.driftMicros),
            result.consistent ? "ok" : "warn",
          );
        })
        .catch((error) => showMessage("billing-message", error.message, "error"));
    };

    el("do-grant").onclick = () => {
      const planId = el("grant-plan").value;
      if (!planId) return;
      api("/api/admin/users/" + encodeURIComponent(userId) + "/subscription", {
        method: "POST",
        body: JSON.stringify({ planId }),
      })
        .then(() => {
          showMessage("plan-message", "套餐已发放（原套餐已被替换）", "ok");
          openUserDetail(userId);
        })
        .catch((error) => showMessage("plan-message", error.message, "error"));
    };

    el("do-revoke").onclick = () => {
      api("/api/admin/users/" + encodeURIComponent(userId) + "/subscription", {
        method: "DELETE",
      })
        .then(() => {
          showMessage("plan-message", "套餐已撤销", "ok");
          openUserDetail(userId);
        })
        .catch((error) => showMessage("plan-message", error.message, "error"));
    };
  });
}

function renderLedgerTable(entries) {
  if (entries.length === 0) {
    return '<span class="muted">没有流水记录。</span>';
  }
  return (
    "<table><thead><tr><th>时间</th><th>类型</th><th>金额</th><th>备注</th><th>请求</th></tr></thead><tbody>" +
    entries
      .map(
        (entry) =>
          "<tr><td>" +
          esc(fmtTime(entry.createdAt)) +
          "</td><td>" +
          esc(entry.kind) +
          "</td><td>" +
          (entry.direction === "credit" ? "+" : "-") +
          esc(entry.amount) +
          "</td><td>" +
          esc(entry.note || "-") +
          "</td><td>" +
          esc(entry.requestId ? entry.requestId.slice(0, 18) : "-") +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table>"
  );
}

function renderUsageTable(records) {
  if (records.length === 0) {
    return '<span class="muted">没有调用记录。</span>';
  }
  return (
    "<table><thead><tr><th>时间</th><th>模型</th><th>状态</th><th>用量</th><th>费用</th></tr></thead><tbody>" +
    records
      .map(
        (record) =>
          "<tr><td>" +
          esc(fmtTime(record.createdAt)) +
          "</td><td>" +
          esc(record.modelId || "-") +
          "</td><td>" +
          esc(record.status) +
          "</td><td>" +
          esc(fmtTokens(record.usage)) +
          "</td><td>" +
          esc(fmtMicros(record.costMicros)) +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table>"
  );
}
