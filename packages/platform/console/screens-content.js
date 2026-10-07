/** 管理后台：概览、模型目录、上游、单价、套餐、客户端发布。 */
import { api, el, esc, field, fmtMicros, fmtTime, metric, showMessage, state } from "./api.js";

export function renderDashboard() {
  return Promise.all([
    api("/api/admin/usage/totals?sinceDays=30"),
    api("/api/admin/usage/by-user?sinceDays=30&limit=20"),
  ]).then((results) => {
    const totals = results[0].totals;
    const byUser = results[1].users;
    el("panel").innerHTML =
      '<section class="section"><h2>最近 30 天用量</h2><div class="metrics">' +
      metric("调用次数", totals.requestCount) +
      metric("失败次数", totals.errorCount) +
      metric("输入 token", totals.inputTokens) +
      metric("输出 token", totals.outputTokens) +
      metric("消费", fmtMicros(totals.costMicros)) +
      "</div></section>" +
      '<section class="section"><h2>用户消费排行</h2>' +
      (byUser.length === 0
        ? '<span class="muted">最近 30 天没有调用记录。</span>'
        : "<table><thead><tr><th>用户</th><th>调用</th><th>失败</th><th>输入</th><th>输出</th><th>消费</th></tr></thead><tbody>" +
          byUser
            .map(
              (row) =>
                "<tr><td>" +
                esc(row.email || row.userId) +
                "</td><td>" +
                row.totals.requestCount +
                "</td><td>" +
                row.totals.errorCount +
                "</td><td>" +
                row.totals.inputTokens +
                "</td><td>" +
                row.totals.outputTokens +
                "</td><td>" +
                esc(row.totals.cost) +
                "</td></tr>",
            )
            .join("") +
          "</tbody></table>") +
      "</section>";
  });
}

export function renderCatalog() {
  return api("/api/admin/catalog").then((body) => {
    el("panel").innerHTML =
      '<section class="section"><h2>模型目录</h2>' +
      '<p class="muted">' +
      "客户端会定期拉取这份目录（约 1 分钟内生效），所以改完模型列表不需要重新发客户端。" +
      "保存时必须让顶层 <code>revision</code> 大于当前值，否则客户端不会应用。" +
      "目录里<strong>不要写上游 API key</strong>：它是全站共享、任何人可下载的。" +
      "</p>" +
      '<div class="row"><div class="field"><label>当前 revision</label>' +
      '<input id="catalog-revision" value="' +
      esc(body.revision === null ? "（尚未导入）" : body.revision) +
      '" disabled /></div>' +
      (body.summary
        ? '<div class="field"><label>摘要</label><input value="provider ' +
          esc(body.summary.providerCount) +
          " 个 / 模型 " +
          esc(body.summary.modelCount) +
          ' 条" disabled /></div>'
        : "") +
      '<button class="btn primary" id="save-catalog">保存</button>' +
      '<button class="btn" id="reload-catalog">重新加载</button>' +
      "</div>" +
      '<div id="catalog-message" class="message"></div>' +
      "<h3>目录内容（JSON）</h3>" +
      '<textarea id="catalog-content" spellcheck="false">' +
      esc(body.content || "") +
      "</textarea>" +
      "</section>";

    el("save-catalog").onclick = () => {
      const content = el("catalog-content").value;
      try {
        JSON.parse(content);
      } catch (error) {
        showMessage("catalog-message", "内容不是合法 JSON：" + error.message, "error");
        return;
      }
      api("/api/admin/catalog", {
        method: "PUT",
        body: JSON.stringify({ content, expectedRevision: body.revision }),
      })
        .then((result) => {
          showMessage("catalog-message", "已保存为 revision " + result.revision, "ok");
          renderCatalog();
        })
        .catch((error) => showMessage("catalog-message", error.message, "error"));
    };

    el("reload-catalog").onclick = () => renderCatalog();
  });
}

export function renderProviders() {
  return api("/api/admin/providers").then((body) => {
    state.providers = body.providers;
    const rows = state.providers
      .map(
        (provider) =>
          "<tr><td>" +
          esc(provider.id) +
          "</td><td>" +
          esc(provider.label) +
          "</td><td>" +
          esc(provider.upstreamBaseUrl) +
          "</td><td>" +
          esc(provider.protocol) +
          "</td><td>" +
          (provider.enabled ? "启用" : "停用") +
          "</td><td>" +
          esc(provider.apiKeyHint) +
          '</td><td class="actions">' +
          '<button class="btn small" data-action="edit-provider" data-id="' +
          esc(provider.id) +
          '">编辑</button>' +
          '<button class="btn small danger" data-action="delete-provider" data-id="' +
          esc(provider.id) +
          '">删除</button></td></tr>',
      )
      .join("");

    el("panel").innerHTML =
      '<section class="section"><h2>上游 provider</h2>' +
      '<p class="muted">客户端把平台管理的模型指向 <code>/api/v1/gateway/&lt;id&gt;</code>，' +
      "网关按这里的配置转发到真实上游，并注入这里的 API key。" +
      "key 只写不读：列表里只显示末四位。</p>" +
      '<div class="row">' +
      field("provider-id", "id（客户端目录里引用它）", "text") +
      field("provider-label", "显示名", "text") +
      field("provider-url", "上游 baseUrl（如 https://api.anthropic.com）", "text") +
      '<div class="field"><label for="provider-protocol">协议</label><select id="provider-protocol">' +
      '<option value="anthropic">anthropic</option><option value="openai">openai</option>' +
      '<option value="openai-compatible">openai-compatible</option></select></div>' +
      field("provider-key", "API key（编辑时留空表示不改）", "password") +
      '<button class="btn primary" id="save-provider">保存</button>' +
      "</div>" +
      '<div id="provider-message" class="message"></div></section>' +
      '<section class="section"><h2>已有上游</h2>' +
      (state.providers.length === 0
        ? '<span class="muted">还没有配置上游。客户端目录指向网关但没有上游时，模型调用会返回 404。</span>'
        : "<table><thead><tr><th>id</th><th>显示名</th><th>baseUrl</th><th>协议</th><th>状态</th><th>key</th><th>操作</th></tr></thead><tbody>" +
          rows +
          "</tbody></table>") +
      "</section>";

    el("save-provider").onclick = () => {
      const id = el("provider-id").value.trim();
      if (!id) {
        showMessage("provider-message", "id 不能为空", "error");
        return;
      }
      api("/api/admin/providers/" + encodeURIComponent(id), {
        method: "PUT",
        body: JSON.stringify({
          label: el("provider-label").value,
          upstreamBaseUrl: el("provider-url").value,
          protocol: el("provider-protocol").value,
          apiKey: el("provider-key").value,
          enabled: true,
        }),
      })
        .then(() => {
          showMessage("provider-message", "已保存", "ok");
          renderProviders();
        })
        .catch((error) => showMessage("provider-message", error.message, "error"));
    };
  });
}

export function renderPrices() {
  return api("/api/admin/prices").then((body) => {
    const rows = body.prices
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
          '</td><td class="actions">' +
          '<button class="btn small" data-action="edit-price" data-model="' +
          esc(price.modelId) +
          '">编辑</button>' +
          '<button class="btn small danger" data-action="delete-price" data-model="' +
          esc(price.modelId) +
          '">删除</button></td></tr>',
      )
      .join("");

    el("panel").innerHTML =
      '<section class="section"><h2>模型单价</h2>' +
      '<p class="muted">单位是「每百万 token 的金额」。模型 id 必须与客户端请求体里的 ' +
      "<code>model</code> 字段一致。没有配单价的模型按 0 计费（只计量不扣费）。</p>" +
      '<div class="row">' +
      field("price-model", "模型 id", "text") +
      field("price-input", "输入", "text") +
      field("price-output", "输出", "text") +
      field("price-cache-read", "缓存读", "text") +
      field("price-cache-write", "缓存写", "text") +
      '<button class="btn primary" id="save-price">保存</button></div>' +
      '<div id="price-message" class="message"></div></section>' +
      '<section class="section"><h2>已配置单价</h2>' +
      (body.prices.length === 0
        ? '<span class="muted">还没有配置任何单价。</span>'
        : "<table><thead><tr><th>模型</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>操作</th></tr></thead><tbody>" +
          rows +
          "</tbody></table>") +
      "</section>";

    el("save-price").onclick = () => {
      const modelId = el("price-model").value.trim();
      if (!modelId) {
        showMessage("price-message", "模型 id 不能为空", "error");
        return;
      }
      api("/api/admin/prices/" + encodeURIComponent(modelId), {
        method: "PUT",
        body: JSON.stringify({
          input: el("price-input").value,
          output: el("price-output").value,
          cacheRead: el("price-cache-read").value,
          cacheWrite: el("price-cache-write").value,
        }),
      })
        .then(() => {
          showMessage("price-message", "已保存", "ok");
          renderPrices();
        })
        .catch((error) => showMessage("price-message", error.message, "error"));
    };
  });
}

export function renderPlans() {
  return api("/api/admin/plans").then((body) => {
    state.plans = body.plans;
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
          '<button class="btn small danger" data-action="delete-plan" data-id="' +
          esc(plan.id) +
          '">删除</button></td></tr>',
      )
      .join("");

    el("panel").innerHTML =
      '<section class="section"><h2>新建套餐</h2>' +
      '<p class="muted">套餐提供额度池，并可选限定可用模型。额度用尽后继续按余额扣费。</p>' +
      '<div class="row">' +
      field("plan-name", "名称", "text") +
      field("plan-quota", "额度（如 100）", "text") +
      field("plan-days", "有效天数（留空为长期）", "text") +
      field("plan-models", "限定模型（逗号分隔，留空不限制）", "text") +
      '<button class="btn primary" id="create-plan">创建</button></div>' +
      '<div id="plan-message" class="message"></div></section>' +
      '<section class="section"><h2>已有套餐</h2>' +
      (state.plans.length === 0
        ? '<span class="muted">还没有套餐。</span>'
        : "<table><thead><tr><th>名称</th><th>额度</th><th>有效期</th><th>限定模型</th><th>操作</th></tr></thead><tbody>" +
          rows +
          "</tbody></table>") +
      "</section>";

    el("create-plan").onclick = () => {
      const models = el("plan-models")
        .value.split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      api("/api/admin/plans", {
        method: "POST",
        body: JSON.stringify({
          name: el("plan-name").value,
          quota: el("plan-quota").value,
          durationDays: el("plan-days").value || null,
          allowedModels: models,
        }),
      })
        .then(() => {
          showMessage("plan-message", "套餐已创建", "ok");
          renderPlans();
        })
        .catch((error) => showMessage("plan-message", error.message, "error"));
    };
  });
}

export function renderReleases() {
  return api("/api/admin/releases").then((body) => {
    const rows = body.releases
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
          (release.sizeBytes ? Math.round(release.sizeBytes / 1024 / 1024) + " MB" : "-") +
          "</td><td>" +
          esc(fmtTime(release.createdAt)) +
          '</td><td class="actions">' +
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
      "<br /><strong>注意</strong>：未签名的安装包在 macOS 上无法自动安装（系统会拒绝），" +
      "Windows 也会被 SmartScreen 拦截，此时应手动分发给用户。</p>" +
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
      field("release-notes", "发布说明（可选）", "text") +
      '<button class="btn primary" id="upload-release">上传并发布</button>' +
      "</div>" +
      '<div id="release-message" class="message"></div></section>' +
      '<section class="section"><h2>已登记版本</h2>' +
      (body.releases.length === 0
        ? '<span class="muted">还没有登记任何版本。</span>'
        : "<table><thead><tr><th>版本</th><th>通道</th><th>平台</th><th>文件名</th><th>大小</th><th>登记时间</th><th>操作</th></tr></thead><tbody>" +
          rows +
          "</tbody></table>") +
      "</section>";

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
      showMessage("release-message", "上传中，请勿关闭页面…", "warn");
      api(
        "/api/admin/releases/" +
          encodeURIComponent(version) +
          "/" +
          encodeURIComponent(file.name) +
          query,
        { method: "PUT", body: file },
      )
        .then(() => {
          showMessage("release-message", "已发布 " + version, "ok");
          renderReleases();
        })
        .catch((error) => showMessage("release-message", error.message, "error"));
    };
  });
}
