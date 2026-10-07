/**
 * 管理后台入口：框架渲染、事件绑定与启动。
 *
 * 页面逻辑按职责拆成三个 ES 模块（api / screens-users / screens-content），
 * 由浏览器原生加载，不需要打包步骤。
 */
import {
  api,
  el,
  esc,
  getToken,
  handleAuthFailure,
  setToken,
  showMessage,
  state,
  TABS,
  toast,
} from "./api.js";
import { configureUserScreens, openUserDetail, renderUsers } from "./screens-users.js";
import {
  renderCatalog,
  renderDashboard,
  renderPlans,
  renderPrices,
  renderProviders,
  renderReleases,
} from "./screens-content.js";

const SCREENS = {
  dashboard: renderDashboard,
  users: renderUsers,
  catalog: renderCatalog,
  providers: renderProviders,
  prices: renderPrices,
  plans: renderPlans,
  releases: renderReleases,
};

function report(error) {
  if (handleAuthFailure(error, renderChrome)) {
    toast("登录已失效，请重新登录", true);
    return;
  }
  toast(error && error.message ? error.message : String(error), true);
}

// 子模块需要"重绘当前页"，但不应反向依赖入口模块，因此在这里注入。
configureUserScreens({ rerender: () => renderPanel() });
configureContentScreens({ rerender: () => renderPanel() });

function renderChrome() {
  const signedIn = Boolean(getToken());
  el("login-view").className = signedIn ? "hidden" : "login-wrap";
  el("app-view").className = signedIn ? "" : "hidden";
  el("logout-button").className = signedIn ? "btn" : "btn hidden";
  el("current-user").textContent = "";

  el("tabs").innerHTML = signedIn
    ? TABS.map(
        (item) =>
          '<button class="tab' +
          (state.tab === item[0] ? " active" : "") +
          '" data-tab="' +
          item[0] +
          '">' +
          esc(item[1]) +
          "</button>",
      ).join("")
    : "";

  if (!signedIn) {
    el("panel").innerHTML = "";
    return;
  }

  api("/api/auth/me")
    .then((body) => {
      el("current-user").textContent = body.user.email + " · " + body.user.role;
    })
    .catch(() => {
      // /me 失败通常意味着令牌过期；下一次写操作会触发统一的失效处理。
    });
}

function renderPanel() {
  const panel = el("panel");
  panel.innerHTML = '<div class="section"><span class="muted">加载中…</span></div>';
  const renderer = SCREENS[state.tab];
  if (!renderer) {
    panel.innerHTML = "";
    return;
  }
  Promise.resolve(renderer()).catch(report);
}

function switchTab(tab) {
  state.tab = tab;
  state.userDetailId = null;
  renderChrome();
  renderPanel();
}

el("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  showMessage("login-message", "");
  api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: el("login-email").value,
      password: el("login-password").value,
    }),
  })
    .then((body) => {
      if (body.user.role !== "admin") {
        showMessage("login-message", "该账号不是管理员", "error");
        return;
      }
      setToken(body.token);
      el("login-password").value = "";
      renderChrome();
      renderPanel();
    })
    .catch((error) => showMessage("login-message", error.message, "error"));
});

el("logout-button").addEventListener("click", () => {
  api("/api/auth/logout", { method: "POST" })
    .catch(() => {
      // 令牌可能已经失效；无论如何都要回到未登录界面。
    })
    .then(() => {
      setToken("");
      renderChrome();
    });
});

el("tabs").addEventListener("click", (event) => {
  const target = event.target;
  if (target && target.dataset && target.dataset.tab) {
    switchTab(target.dataset.tab);
  }
});

el("panel").addEventListener("click", (event) => {
  const target = event.target;
  if (!target || !target.dataset || !target.dataset.action) {
    return;
  }
  const { action, id, model } = target.dataset;

  if (action === "detail") {
    openUserDetail(id);
    return;
  }
  if (action === "toggle-status") {
    const next = target.dataset.status === "active" ? "disabled" : "active";
    api("/api/admin/users/" + encodeURIComponent(id), {
      method: "PATCH",
      body: JSON.stringify({ status: next }),
    })
      .then(() => {
        toast(next === "disabled" ? "已停用（该用户会话立即失效）" : "已启用");
        renderPanel();
      })
      .catch(report);
    return;
  }
  if (action === "reset-password") {
    const password = window.prompt(
      "为该用户设置新密码（至少 8 位）。重置后该用户全部会话立即失效。",
    );
    if (!password) return;
    api("/api/admin/users/" + encodeURIComponent(id) + "/password", {
      method: "POST",
      body: JSON.stringify({ newPassword: password }),
    })
      .then(() => toast("密码已重置，该用户已被强制下线"))
      .catch(report);
    return;
  }
  if (action === "edit-provider") {
    const provider = state.providers.find((item) => item.id === id);
    if (!provider) return;
    el("provider-id").value = provider.id;
    el("provider-label").value = provider.label;
    el("provider-url").value = provider.upstreamBaseUrl;
    el("provider-protocol").value = provider.protocol;
    el("provider-key").value = "";
    toast("已载入到表单；API key 留空表示不修改");
    return;
  }
  if (action === "delete-provider") {
    if (!window.confirm("删除该上游？指向它的模型调用会立即失败。")) return;
    api("/api/admin/providers/" + encodeURIComponent(id), { method: "DELETE" })
      .then(() => {
        toast("已删除");
        renderPanel();
      })
      .catch(report);
    return;
  }
  if (action === "edit-price") {
    el("price-model").value = model;
    toast("模型 id 已载入；填写金额后点保存");
    return;
  }
  if (action === "delete-price") {
    if (!window.confirm("删除该模型的单价？之后调用它不再计费。")) return;
    api("/api/admin/prices/" + encodeURIComponent(model), { method: "DELETE" })
      .then(() => {
        toast("已删除");
        renderPanel();
      })
      .catch(report);
    return;
  }
  if (action === "delete-plan") {
    if (!window.confirm("删除该套餐？仍有订阅引用时会被拒绝。")) return;
    api("/api/admin/plans/" + encodeURIComponent(id), { method: "DELETE" })
      .then(() => {
        toast("已删除");
        renderPanel();
      })
      .catch(report);
    return;
  }
  if (action === "delete-release") {
    if (!window.confirm("删除该版本登记？已上传的安装包文件不会被删除。")) return;
    api("/api/admin/releases/" + encodeURIComponent(id), { method: "DELETE" })
      .then(() => {
        toast("已删除");
        renderPanel();
      })
      .catch(report);
  }
});

renderChrome();
if (getToken()) {
  renderPanel();
}
