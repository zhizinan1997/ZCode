/**
 * 管理后台：用户页（列表、新建、搜索、分页、批量发放套餐、我的 API Key）
 * 与用户详情（余额、充值/调整/对账、套餐、流水、调用记录）。
 *
 * 状态所有者：用户资料/状态由账号服务持有，余额/预扣/流水由计费服务持有；
 * 本页只负责发起操作与展示，不在前端保存任何一份"事实"，
 * 每次操作后重新拉取（分页偏移量等纯 UI 暂存放在 state.usersUsers）。
 *
 * 注册时序：app.js 的 import 会先求值本模块，此时其 const SCREENS 尚未初始化（TDZ），
 * 因此必须在 queueMicrotask 里调用 registerScreen（模块求值完毕后 SCREENS 已就绪）。
 */
import { registerScreen } from "./app.js";
import {
  api,
  confirmModal,
  el,
  esc,
  field,
  fmtMicros,
  fmtTime,
  fmtTokens,
  metric,
  promptModal,
  renderPagination,
  showModal,
  showMessage,
  state,
  toast,
} from "./api.js";

const PAGE_SIZE = 50;
const DETAIL_PAGE_SIZE = 20;

// 本页的 UI 暂存（不是服务端事实）：搜索词、列表/流水/调用的分页偏移、调用时间范围。
state.usersUsers = { q: "", offset: 0, ledgerOffset: 0, usageOffset: 0, usageDays: 30 };

/** 生成 16 位随机 hex（8 字节），用于"生成"初始密码。 */
function randomHex16() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 状态徽章：active 绿、disabled 红、其余中性。 */
function statusBadge(status) {
  const kind = status === "active" ? "ok" : status === "disabled" ? "danger" : "";
  return '<span class="badge' + (kind ? " " + kind : "") + '">' + esc(status) + "</span>";
}

/** 调用状态徽章：ok 绿、upstream_error/rejected 红、reserved 警示（styles.css 无 warn 徽章色，退化为中性框）。 */
function usageBadge(status) {
  if (status === "ok") return '<span class="badge ok">ok</span>';
  if (status === "upstream_error" || status === "rejected") {
    return '<span class="badge danger">' + esc(status) + "</span>";
  }
  if (status === "reserved") return '<span class="badge warn">reserved</span>';
  return '<span class="badge">' + esc(status) + "</span>";
}

/**
 * 同步绑定一个分页容器。renderPagination 自己的 rAF 绑定只认页面上第一个
 * .pagination[data-pagination]；详情页同时有三个分页，所以这里在每个分页外包一层
 * 带 id 的容器、渲染后立刻绑定并标记 dataset.bound，renderPagination 的 rAF 会因
 * 该标记跳过，保证每个分页拿到正确的 onPage 回调。
 */
function mountPagination(wrapperId, onPage) {
  const wrapper = el(wrapperId);
  const box = wrapper && wrapper.querySelector(".pagination[data-pagination]");
  if (!box || box.dataset.bound) return;
  box.dataset.bound = "1";
  box.addEventListener("click", (event) => {
    const target = event.target;
    if (target && target.dataset && target.dataset.pageOffset !== undefined && !target.disabled) {
      onPage(Number(target.dataset.pageOffset));
    }
  });
}

/** styles.css 把所有 input 设成 width:100%，复选框会被拉宽；用 CSSOM 收回自然宽度。 */
function compactCheckboxes() {
  for (const node of el("panel").querySelectorAll('input[type="checkbox"]')) {
    node.style.width = "auto";
  }
}

/** 套餐下拉选项；quota 按目标契约原样展示（金额类字段由服务端格式化）。 */
function planOptions(plans) {
  return plans
    .map(
      (plan) =>
        '<option value="' +
        esc(plan.id) +
        '">' +
        esc(plan.name) +
        (plan.quota !== undefined && plan.quota !== null
          ? "（额度 " + esc(plan.quota) + "）"
          : "") +
        "</option>",
    )
    .join("");
}

// ── 用户列表 ────────────────────────────────────────────────

function renderUsers() {
  const pageState = state.usersUsers;
  const query =
    "/api/admin/users?limit=" +
    PAGE_SIZE +
    "&offset=" +
    pageState.offset +
    (pageState.q ? "&q=" + encodeURIComponent(pageState.q) : "");
  // 套餐与自助 Key 列表失败不阻塞用户列表：容错降级为空列表/提示。
  return Promise.all([
    api(query),
    api("/api/admin/plans").catch(() => ({ plans: [] })),
    api("/api/v1/api-keys").catch(() => ({ keys: null })),
  ]).then((results) => {
    const page = results[0];
    state.users = page.users;
    state.plans = results[1].plans;
    const selfKeys = results[2].keys;

    const rows = page.users
      .map(
        (user) =>
          "<tr><td>" +
          '<input type="checkbox" class="user-check" data-id="' +
          esc(user.id) +
          '" /></td><td>' +
          esc(user.email) +
          "</td><td>" +
          esc(user.displayName || "-") +
          "</td><td>" +
          esc(user.role) +
          "</td><td>" +
          statusBadge(user.status) +
          "</td><td>" +
          esc(fmtMicros(user.balanceMicros)) +
          "</td><td>" +
          esc(fmtMicros(user.availableMicros)) +
          "</td><td>" +
          esc(user.planName || "-") +
          (user.planRemainingMicros !== null && user.planRemainingMicros !== undefined
            ? ' <span class="muted">剩 ' + esc(fmtMicros(user.planRemainingMicros)) + "</span>"
            : "") +
          '</td><td class="actions">' +
          '<button class="btn small" data-action="detail" data-id="' +
          esc(user.id) +
          '">详情</button>' +
          '<button class="btn small" data-action="edit-user" data-id="' +
          esc(user.id) +
          '">编辑</button>' +
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
          '<button class="btn small danger" data-action="delete-user" data-id="' +
          esc(user.id) +
          '">删除</button>' +
          "</td></tr>",
      )
      .join("");

    el("panel").innerHTML =
      // 新建用户
      '<section class="section"><h2>新建用户</h2><div class="row">' +
      field("new-email", "邮箱", "email") +
      field("new-password", "初始密码（至少 8 位）", "password") +
      '<button class="btn small" id="gen-password" type="button">生成</button>' +
      field("new-name", "显示名（可选）", "text") +
      '<div class="field"><label for="new-role">角色</label><select id="new-role">' +
      '<option value="user">user</option><option value="admin">admin</option></select></div>' +
      '<button class="btn primary" id="create-user">创建</button></div>' +
      '<div id="create-user-message" class="message"></div></section>' +
      // 搜索
      '<section class="section"><h2>用户列表 <span class="muted">共 ' +
      esc(page.total) +
      " 个</span></h2>" +
      '<div class="row">' +
      '<div class="field"><label for="user-search">搜索（邮箱 / 显示名）</label>' +
      '<input id="user-search" type="text" placeholder="邮箱或显示名" value="' +
      esc(pageState.q) +
      '" /></div>' +
      '<button class="btn" id="user-search-go">搜索</button>' +
      '<button class="btn" id="user-search-clear">清空</button></div>' +
      // 列表
      (page.users.length === 0
        ? '<p class="muted">没有匹配的用户。</p>'
        : '<div class="table-scroll"><table><thead><tr><th><input type="checkbox" id="user-check-all" /></th>' +
          "<th>邮箱</th><th>显示名</th><th>角色</th><th>状态</th><th>余额</th><th>可用</th><th>套餐</th><th>操作</th>" +
          "</tr></thead><tbody>" +
          rows +
          "</tbody></table></div>") +
      '<div id="pg-list">' +
      renderPagination(page.total, PAGE_SIZE, pageState.offset, (nextOffset) => {
        pageState.offset = nextOffset;
        renderUsers();
      }) +
      "</div></section>" +
      // 批量发放套餐
      '<section class="section"><h2>批量发放套餐</h2><div class="row">' +
      '<div class="field"><label for="bulk-plan">套餐</label><select id="bulk-plan">' +
      '<option value="">（选择套餐）</option>' +
      planOptions(state.plans) +
      "</select></div>" +
      '<button class="btn primary" id="bulk-grant">给选中用户发放</button>' +
      '<span class="muted">先在列表里勾选用户；原套餐会被替换。</span></div>' +
      '<div id="bulk-message" class="message"></div></section>' +
      // 我的 API Key（当前登录管理员自己的）
      '<section class="section"><h2>我的 API Key</h2><div id="self-keys-content">' +
      selfKeysContent(selfKeys) +
      "</div></section>" +
      // 详情容器：openUserDetail 打开后由 renderUserDetail 填充
      (state.userDetailId ? '<section class="section" id="user-detail"></section>' : "");

    // ── 行为绑定（innerHTML 重建后需要重新挂） ──
    compactCheckboxes();

    el("gen-password").onclick = () => {
      el("new-password").value = randomHex16();
    };

    el("create-user").onclick = () => {
      showMessage("create-user-message", "");
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
          toast("用户已创建");
          renderUsers();
        })
        .catch((error) => showMessage("create-user-message", error.message, "error"));
    };

    const doSearch = () => {
      pageState.q = el("user-search").value.trim();
      pageState.offset = 0;
      renderUsers();
    };
    el("user-search-go").onclick = doSearch;
    el("user-search").addEventListener("keydown", (event) => {
      if (event.key === "Enter") doSearch();
    });
    el("user-search-clear").onclick = () => {
      el("user-search").value = "";
      pageState.q = "";
      pageState.offset = 0;
      renderUsers();
    };

    const checkAll = el("user-check-all");
    if (checkAll) {
      checkAll.onchange = () => {
        for (const node of el("panel").querySelectorAll(".user-check")) {
          node.checked = checkAll.checked;
        }
      };
    }

    el("bulk-grant").onclick = () => {
      const planId = el("bulk-plan").value;
      if (!planId) {
        showMessage("bulk-message", "请先选择套餐", "error");
        return;
      }
      const userIds = Array.from(
        el("panel").querySelectorAll(".user-check:checked"),
        (node) => node.dataset.id,
      );
      if (userIds.length === 0) {
        showMessage("bulk-message", "请先在列表里勾选用户", "error");
        return;
      }
      showMessage("bulk-message", "");
      api("/api/admin/users/bulk-subscription", {
        method: "POST",
        body: JSON.stringify({ planId, userIds }),
      })
        .then((result) => {
          const failed = (result && result.failed) || [];
          toast(
            "已发放 " +
              ((result && result.granted) || 0) +
              " 个" +
              (failed.length ? "，失败 " + failed.length + " 个" : ""),
            failed.length > 0,
          );
          if (failed.length > 0) {
            // 明细走确认弹层展示前 5 条，避免 toast 放不下。
            const lines = failed
              .slice(0, 5)
              .map((item) => (item.userId || "?") + "：" + (item.error || "未知错误"));
            return confirmModal(
              "部分发放失败",
              "成功 " +
                result.granted +
                " 个，失败 " +
                failed.length +
                " 个。前 " +
                lines.length +
                " 条：" +
                lines.join("；"),
              "知道了",
            );
          }
          return null;
        })
        .then(() => renderUsers())
        .catch((error) => showMessage("bulk-message", error.message, "error"));
    };

    mountPagination("pg-list", (nextOffset) => {
      pageState.offset = nextOffset;
      renderUsers();
    });

    // 详情容器存在则填充（翻页/操作后的刷新路径都会走到这里）。
    if (state.userDetailId) {
      void renderUserDetail(state.userDetailId);
    }
  });
}

/** 我的 API Key 区块内容；keys 为 null 表示列表加载失败。 */
function selfKeysContent(keys) {
  const head =
    '<div class="row"><button class="btn" data-self-action="create-self-key">新建 Key</button>' +
    '<span class="muted">明文只在创建成功后显示一次。</span></div>';
  if (keys === null) {
    return head + '<p class="muted">Key 列表加载失败，请刷新重试。</p>';
  }
  if (keys.length === 0) {
    return head + '<p class="muted">还没有 API Key。</p>';
  }
  const rows = keys
    .map(
      (key) =>
        "<tr><td>" +
        esc(key.name || "-") +
        '</td><td class="mono">' +
        esc(key.keyHint || "-") +
        "</td><td>" +
        esc(fmtTime(key.createdAt)) +
        "</td><td>" +
        esc(fmtTime(key.lastUsedAt)) +
        "</td><td>" +
        (key.revokedAt
          ? '<span class="badge danger">已吊销</span>'
          : '<span class="badge ok">有效</span>') +
        "</td><td>" +
        (key.revokedAt
          ? ""
          : '<button class="btn small danger" data-self-action="revoke-self-key" data-id="' +
            esc(key.id) +
            '">吊销</button>') +
        "</td></tr>",
    )
    .join("");
  return (
    head +
    '<div class="table-scroll"><table><thead><tr><th>名称</th><th>Key</th><th>创建时间</th>' +
    "<th>最后使用</th><th>状态</th><th>操作</th></tr></thead><tbody>" +
    rows +
    "</tbody></table></div>"
  );
}

/** 只刷新"我的 API Key"区块，避免整页重绘打断其它区块。 */
function loadSelfKeys() {
  return api("/api/v1/api-keys")
    .then((body) => {
      const container = el("self-keys-content");
      if (container) container.innerHTML = selfKeysContent(body.keys);
    })
    .catch((error) => toast(error.message, true));
}

// ── 用户详情 ────────────────────────────────────────────────

export function openUserDetail(userId) {
  state.userDetailId = userId;
  // 换一个用户查看时重置详情分页；时间范围保留。
  state.usersUsers.ledgerOffset = 0;
  state.usersUsers.usageOffset = 0;
  return renderUsers();
}

function renderUserDetail(userId) {
  const pageState = state.usersUsers;
  const base = "/api/admin/users/" + encodeURIComponent(userId);
  return Promise.all([
    api(base),
    api(base + "/ledger?limit=" + DETAIL_PAGE_SIZE + "&offset=" + pageState.ledgerOffset),
    api(
      base +
        "/usage?limit=" +
        DETAIL_PAGE_SIZE +
        "&offset=" +
        pageState.usageOffset +
        "&sinceDays=" +
        pageState.usageDays,
    ),
    api("/api/admin/plans").catch(() => ({ plans: state.plans })),
  ])
    .then((results) => {
      const detail = results[0];
      const ledger = results[1];
      const usage = results[2];
      state.plans = results[3].plans;
      const container = el("user-detail");
      if (!container) return;

      container.innerHTML =
        "<h2>" +
        esc(detail.user.email) +
        ' <span class="muted">' +
        esc(detail.user.id) +
        "</span></h2>" +
        '<p class="muted">状态说明：用户资料与状态由账号服务持有；余额、预扣与流水由计费服务持有，' +
        "本页只发起操作并展示结果。</p>" +
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
        '<div class="row">' +
        '<button class="btn small" data-self-action="close-detail">关闭详情</button>' +
        statusBadge(detail.user.status) +
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
        (state.plans.length
          ? planOptions(state.plans)
          : '<option value="">（还没有套餐）</option>') +
        "</select></div>" +
        '<button class="btn primary" id="do-grant">发放</button>' +
        '<button class="btn danger" id="do-revoke">撤销当前套餐</button>' +
        "</div>" +
        '<div id="plan-message" class="message"></div>' +
        "<h3>最近流水</h3>" +
        renderLedgerTable(ledger.entries) +
        '<div id="pg-ledger">' +
        renderPagination(ledger.total, DETAIL_PAGE_SIZE, pageState.ledgerOffset, (nextOffset) => {
          pageState.ledgerOffset = nextOffset;
          renderUserDetail(userId);
        }) +
        "</div>" +
        '<h3>最近调用 <span class="muted">' +
        fmtTokens(usage.totals) +
        "，消费 " +
        esc(fmtMicros(usage.totals.costMicros)) +
        "</span></h3>" +
        '<div class="row">' +
        '<div class="field"><label for="usage-days">时间范围</label><select id="usage-days">' +
        [7, 30, 90, 3650]
          .map(
            (days) =>
              '<option value="' +
              days +
              '"' +
              (days === pageState.usageDays ? " selected" : "") +
              ">" +
              (days === 3650 ? "全部" : "最近 " + days + " 天") +
              "</option>",
          )
          .join("") +
        "</select></div></div>" +
        renderUsageTable(usage.records) +
        '<div id="pg-usage">' +
        renderPagination(usage.total, DETAIL_PAGE_SIZE, pageState.usageOffset, (nextOffset) => {
          pageState.usageOffset = nextOffset;
          renderUserDetail(userId);
        }) +
        "</div>";

      const fail = (targetId) => (error) => showMessage(targetId, error.message, "error");

      el("do-recharge").onclick = () => {
        api(base + "/recharge", {
          method: "POST",
          body: JSON.stringify({ amount: el("recharge-amount").value }),
        })
          .then(() => {
            showMessage("billing-message", "充值成功", "ok");
            renderUserDetail(userId);
          })
          .catch(fail("billing-message"));
      };

      el("do-adjust").onclick = () => {
        api(base + "/adjust", {
          method: "POST",
          body: JSON.stringify({
            delta: el("adjust-amount").value,
            note: el("adjust-note").value,
          }),
        })
          .then(() => {
            showMessage("billing-message", "调整成功", "ok");
            renderUserDetail(userId);
          })
          .catch(fail("billing-message"));
      };

      el("do-reconcile").onclick = () => {
        api(base + "/reconcile")
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
          .catch(fail("billing-message"));
      };

      el("do-grant").onclick = () => {
        const planId = el("grant-plan").value;
        if (!planId) {
          showMessage("plan-message", "请先选择套餐", "error");
          return;
        }
        api(base + "/subscription", {
          method: "POST",
          body: JSON.stringify({ planId }),
        })
          .then(() => {
            showMessage("plan-message", "套餐已发放（原套餐已被替换）", "ok");
            renderUserDetail(userId);
          })
          .catch(fail("plan-message"));
      };

      el("do-revoke").onclick = () => {
        api(base + "/subscription", { method: "DELETE" })
          .then(() => {
            showMessage("plan-message", "套餐已撤销", "ok");
            renderUserDetail(userId);
          })
          .catch(fail("plan-message"));
      };

      el("usage-days").onchange = (event) => {
        pageState.usageDays = Number(event.target.value) || 30;
        pageState.usageOffset = 0;
        renderUserDetail(userId);
      };

      // 流水/调用分页：同步绑定（见 mountPagination 注释）。
      mountPagination("pg-ledger", (nextOffset) => {
        pageState.ledgerOffset = nextOffset;
        renderUserDetail(userId);
      });
      mountPagination("pg-usage", (nextOffset) => {
        pageState.usageOffset = nextOffset;
        renderUserDetail(userId);
      });
    })
    .catch((error) => {
      // 详情加载失败（如用户刚被删除）就地提示，不影响列表。
      const container = el("user-detail");
      if (container) {
        container.innerHTML = '<p class="muted">详情加载失败：' + esc(error.message) + "</p>";
      }
    });
}

function renderLedgerTable(entries) {
  if (!entries || entries.length === 0) {
    return '<span class="muted">没有流水记录。</span>';
  }
  return (
    '<div class="table-scroll"><table><thead><tr><th>时间</th><th>类型</th><th>金额</th><th>备注</th><th>请求</th>' +
    "</tr></thead><tbody>" +
    entries
      .map(
        (entry) =>
          "<tr><td>" +
          esc(fmtTime(entry.createdAt)) +
          "</td><td>" +
          esc(entry.kind) +
          "</td><td>" +
          (entry.direction === "credit" ? "+" : "−") +
          esc(entry.amount) +
          "</td><td>" +
          esc(entry.note || "-") +
          '</td><td class="mono">' +
          esc(entry.requestId ? entry.requestId.slice(0, 18) : "-") +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}

function renderUsageTable(records) {
  if (!records || records.length === 0) {
    return '<span class="muted">没有调用记录。</span>';
  }
  return (
    '<div class="table-scroll"><table><thead><tr><th>时间</th><th>模型</th><th>状态</th><th>用量</th><th>费用</th>' +
    "</tr></thead><tbody>" +
    records
      .map(
        (record) =>
          "<tr><td>" +
          esc(fmtTime(record.createdAt)) +
          "</td><td>" +
          esc(record.modelId || "-") +
          "</td><td>" +
          usageBadge(record.status) +
          "</td><td>" +
          esc(fmtTokens(record.usage)) +
          "</td><td>" +
          esc(fmtMicros(record.costMicros)) +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}

// ── 本页专属动作（app.js 的全局 data-action 不覆盖的部分） ──
// 面板级委托只注册一次；app.js 的同名委托对未知 action 直接忽略，互不干扰。

el("panel").addEventListener("click", (event) => {
  const target = event.target;
  if (!target || !target.dataset) return;
  const action = target.dataset.action;
  const selfAction = target.dataset.selfAction;
  const id = target.dataset.id;

  if (action === "edit-user") {
    const user = (state.users || []).find((item) => item.id === id);
    if (!user) return;
    showModal({
      title: "编辑用户",
      text: user.email,
      fields: [
        { id: "displayName", label: "显示名", type: "text", value: user.displayName || "" },
        { id: "email", label: "邮箱", type: "email", value: user.email },
      ],
      okLabel: "保存",
    }).then((result) => {
      if (!result) return;
      const email = result.values.email.trim();
      if (!email) {
        toast("邮箱不能为空", true);
        return;
      }
      const displayName = result.values.displayName.trim();
      api("/api/admin/users/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify({
          email,
          ...(displayName ? { displayName } : {}),
        }),
      })
        .then(() => {
          toast("已保存");
          renderUsers();
        })
        .catch((error) => toast(error.message, true));
    });
    return;
  }

  if (action === "delete-user") {
    confirmModal(
      "删除用户",
      "该用户的会话与 API Key 将全部失效，余额记录随级联删除。确定删除？",
      "删除",
    ).then((ok) => {
      if (!ok) return;
      api("/api/admin/users/" + encodeURIComponent(id), { method: "DELETE" })
        .then(() => {
          if (state.userDetailId === id) state.userDetailId = null;
          toast("用户已删除");
          renderUsers();
        })
        .catch((error) => toast(error.message, true));
    });
    return;
  }

  if (selfAction === "close-detail") {
    state.userDetailId = null;
    renderUsers();
    return;
  }

  if (selfAction === "create-self-key") {
    promptModal("新建 API Key", "名称仅用于识别；明文只在创建成功后显示一次。", {
      id: "name",
      label: "名称",
      type: "text",
    }).then((name) => {
      if (name === null) return;
      api("/api/v1/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() || undefined }),
      })
        .then((created) => {
          toast("API Key 已创建");
          // showModal 同步填充字段；先拿到弹层 Promise 再补复制按钮，
          // 保证按钮在弹层打开期间就位（关闭后随 modal-fields 一起清空）。
          const modalPromise = showModal({
            title: "API Key 已创建",
            text: "明文只显示这一次，请立即保存：",
            fields: [
              { id: "plaintext", label: "API Key 明文", type: "text", value: created.plaintext },
            ],
            okLabel: "我已保存",
          });
          appendModalCopyButton(created.plaintext);
          return modalPromise.then(() => loadSelfKeys());
        })
        .catch((error) => toast(error.message, true));
    });
    return;
  }

  if (selfAction === "revoke-self-key") {
    // 自助吊销必须走 /api/v1（本人校验）；app.js 的 revoke-apikey 走管理端接口，不能混用。
    confirmModal("吊销 API Key", "吊销后使用该 Key 的调用立即 401。确定吊销？", "吊销").then(
      (ok) => {
        if (!ok) return;
        api("/api/v1/api-keys/" + encodeURIComponent(id), { method: "DELETE" })
          .then(() => {
            toast("已吊销");
            loadSelfKeys();
          })
          .catch((error) => toast(error.message, true));
      },
    );
    return;
  }
});

// 明文 Key 的复制按钮挂在弹层里，app.js 的 copy-text 委托只覆盖 #panel，
// 所以这里在 #modal-fields 上补一份同契约（data-action="copy-text"）的委托。
el("modal-fields").addEventListener("click", (event) => {
  const target = event.target;
  if (!target || !target.dataset || target.dataset.action !== "copy-text") return;
  const text = target.dataset.copyValue || "";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast("已复制"),
      () => toast("复制失败", true),
    );
  } else {
    toast("浏览器不支持复制", true);
  }
});

/** 创建成功后往明文弹层里补一个复制按钮（showModal 只支持字段输入）。 */
function appendModalCopyButton(plaintext) {
  const fields = el("modal-fields");
  if (!fields) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn small";
  button.setAttribute("data-action", "copy-text");
  button.setAttribute("data-copy-value", plaintext);
  button.textContent = "复制明文";
  fields.appendChild(button);
}

// 注册本页：queueMicrotask 等 app.js 的 SCREENS 完成初始化（见文件头注释）。
queueMicrotask(() =>
  registerScreen("users", Object.assign(renderUsers, { openDetail: openUserDetail })),
);
