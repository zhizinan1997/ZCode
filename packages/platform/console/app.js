/**
 * 管理后台入口：屏幕注册表、全局事件绑定与启动。
 *
 * 页面逻辑按职责拆成多个 ES 模块（api / screens-users / screens-content /
 * screens-operations），由浏览器原生加载，不需要打包步骤。
 * 每个模块通过 registerScreen 注册自己的渲染器，入口不 import 任何页面实现细节。
 */
import {
  api,
  confirmModal,
  el,
  esc,
  getToken,
  handleAuthFailure,
  promptModal,
  setToken,
  setupModal,
  showMessage,
  showModal,
  state,
  TABS,
  toast,
} from "./api.js";

/** 屏幕注册表：tab id → 渲染器（返回 Promise）。由各页面模块注册。 */
const SCREENS = {};

export function registerScreen(id, renderer) {
  SCREENS[id] = renderer;
}

function report(error) {
  if (handleAuthFailure(error, renderChrome)) {
    toast("登录已失效，请重新登录", true);
    return;
  }
  toast(error && error.message ? error.message : String(error), true);
}

// ── 页面模块加载与注册 ─────────────────────────────────────
// 入口只依赖各模块的注册副作用；模块之间不互相引用。

import "./screens-users.js";
import "./screens-content.js";
import "./screens-operations.js";
import "./screens-publish.js";

function renderChrome() {
  const signedIn = Boolean(getToken());
  el("login-view").className = signedIn ? "hidden" : "login-wrap";
  el("app-view").className = signedIn ? "" : "hidden";
  el("logout-button").className = signedIn ? "btn" : "btn hidden";
  el("change-password-button").className = signedIn ? "btn" : "btn hidden";
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
    panel.innerHTML = '<div class="section"><span class="muted">页面未注册。</span></div>';
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

// 管理员自助改密：走 /api/auth/password，改完保留当前会话。
el("change-password-button").addEventListener("click", () => {
  promptModal("修改自己的密码", "改密后其它设备的会话将被下线。", {
    id: "current",
    label: "当前密码",
    type: "password",
  })
    .then((first) => {
      if (first === null) return null;
      return promptModal("修改自己的密码", "", {
        id: "next",
        label: "新密码（至少 8 位）",
        type: "password",
      }).then((second) => (second === null ? null : { current: first, next: second }));
    })
    .then((input) => {
      if (!input) return;
      return api("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: input.current,
          newPassword: input.next,
        }),
      })
        .then(() => toast("密码已修改"))
        .catch(report);
    });
});

el("tabs").addEventListener("click", (event) => {
  const target = event.target;
  if (target && target.dataset && target.dataset.tab) {
    switchTab(target.dataset.tab);
  }
});

/**
 * panel 上的动作分发：data-action 属性驱动。
 * 页面自己的复杂交互（表单提交等）由页面模块绑定；这里只放全局通用的行内动作。
 */
el("panel").addEventListener("click", (event) => {
  const target = event.target;
  if (!target || !target.dataset || !target.dataset.action) {
    return;
  }
  const { action, id, model } = target.dataset;

  if (action === "detail") {
    // 用户详情由 screens-users 内部处理；这里透传。
    if (SCREENS.users && typeof SCREENS.users.openDetail === "function") {
      SCREENS.users.openDetail(id);
    }
    return;
  }
  if (action === "copy-text") {
    const text = target.dataset.copyValue || "";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast("已复制"),
        () => toast("复制失败", true),
      );
    } else {
      toast("浏览器不支持复制", true);
    }
    return;
  }
  if (action === "delete-price") {
    confirmModal(
      "删除单价",
      "删除后模型 " + (model || "") + " 立即按 0 计费（免费）。确定删除？",
      "删除",
    ).then((ok) => {
      if (!ok) return;
      api("/api/admin/prices/" + encodeURIComponent(model), { method: "DELETE" })
        .then(() => {
          toast("已删除");
          renderPanel();
        })
        .catch(report);
    });
    return;
  }
  if (action === "delete-plan") {
    confirmModal("删除套餐", "仍有订阅引用时会被拒绝。确定删除该套餐？", "删除").then((ok) => {
      if (!ok) return;
      api("/api/admin/plans/" + encodeURIComponent(id), { method: "DELETE" })
        .then(() => {
          toast("已删除");
          renderPanel();
        })
        .catch(report);
    });
    return;
  }
  if (action === "delete-release") {
    confirmModal("删除版本登记", "已上传的安装包文件不会被删除。确定删除？", "删除").then((ok) => {
      if (!ok) return;
      api("/api/admin/releases/" + encodeURIComponent(id), { method: "DELETE" })
        .then(() => {
          toast("已删除");
          renderPanel();
        })
        .catch(report);
    });
    return;
  }
  if (action === "delete-redeem") {
    confirmModal("吊销兑换码", "吊销后不能再核销；已核销的入账保留。确定吊销？", "吊销").then(
      (ok) => {
        if (!ok) return;
        api("/api/admin/redeem-codes/" + encodeURIComponent(id), { method: "DELETE" })
          .then(() => {
            toast("已吊销");
            renderPanel();
          })
          .catch(report);
      },
    );
    return;
  }
  if (action === "revoke-apikey") {
    confirmModal("吊销 API Key", "吊销后使用该 Key 的调用立即 401。确定吊销？", "吊销").then(
      (ok) => {
        if (!ok) return;
        api("/api/admin/api-keys/" + encodeURIComponent(id), { method: "DELETE" })
          .then(() => {
            toast("已吊销");
            renderPanel();
          })
          .catch(report);
      },
    );
    return;
  }
  if (action === "reset-password") {
    // 管理员重置用户密码：受控弹层 + 可生成随机密码，只显示一次。
    promptModal(
      "重置密码",
      "输入新密码，或留空让系统生成随机密码（生成值只显示一次）。重置后该用户全部会话立即失效。",
      { id: "password", label: "新密码（至少 8 位，留空自动生成）", type: "password" },
    ).then((password) => {
      if (password === null) return;
      let value = password;
      let generated = false;
      if (!value.trim()) {
        const bytes = new Uint8Array(12);
        crypto.getRandomValues(bytes);
        value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        generated = true;
      }
      api("/api/admin/users/" + encodeURIComponent(id) + "/password", {
        method: "POST",
        body: JSON.stringify({ newPassword: value }),
      })
        .then(() => {
          if (generated) {
            return showModal({
              title: "密码已重置",
              text: "请把新密码告知用户；关闭后不再显示：",
              fields: [{ id: "generated", label: "新密码", type: "text", value }],
              okLabel: "我已保存",
            });
          }
          toast("密码已重置，该用户已被强制下线");
          return null;
        })
        .catch(report);
    });
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
  if (action === "edit-provider") {
    // 由 screens-content 的 providers 屏处理：通过自定义事件通知。
    document.dispatchEvent(new CustomEvent("screen:providers", { detail: { edit: id } }));
    return;
  }
  if (action === "edit-price") {
    document.dispatchEvent(new CustomEvent("screen:prices", { detail: { edit: model } }));
    return;
  }
  if (action === "edit-plan") {
    document.dispatchEvent(new CustomEvent("screen:plans", { detail: { edit: id } }));
    return;
  }
  if (action === "delete-provider") {
    const references = target.dataset.references || "";
    confirmModal(
      "删除上游",
      references
        ? "该上游仍被 " + references + " 个已发布模型引用：删除后客户端调用这些模型会 404。"
        : "确定删除该上游？指向它的模型调用会立即失败。",
      "删除",
    ).then((ok) => {
      if (!ok) return;
      api("/api/admin/providers/" + encodeURIComponent(id), { method: "DELETE" })
        .then(() => {
          toast("已删除");
          renderPanel();
        })
        .catch(report);
    });
    return;
  }
  if (action === "test-provider") {
    toast("测试中…");
    api("/api/admin/providers/" + encodeURIComponent(id) + "/test", { method: "POST" })
      .then((result) => {
        if (result.ok) {
          toast("连接成功：" + result.latencyMs + " ms，模型 " + result.modelCount + " 个");
        } else {
          toast("连接失败：" + (result.error || "未知错误"), true);
        }
      })
      .catch(report);
    return;
  }
});

setupModal();
renderChrome();
if (getToken()) {
  renderPanel();
}
