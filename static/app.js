/* DMX 灯具地址编排台 —— 原生 JavaScript 前端 */
"use strict";

const state = {
  catalog: [],
  fixtures: [],
  lines: [],
  reservations: [],
  version: null,
  latestPublishedPlanId: null,
  preview: null, // 当前展示的预览 payload（feasible 时）
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = data && data.detail ? data.detail : `HTTP ${res.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}

function toast(message, kind = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---------- Tabs ----------
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    $$(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`#tab-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "published") loadPublished();
  });
});

// ---------- 全局版本 ----------
async function refreshVersion() {
  const v = await api("/api/plans/version");
  state.version = v.config_version;
  state.latestPublishedPlanId = v.latest_published_plan_id;
  $("#version-badge").textContent = `配置版本 v${v.config_version}`;
  $("#published-badge").textContent = v.latest_published_plan_id
    ? `已发布 #${v.latest_published_plan_id}`
    : "未发布";
  $("#published-badge").classList.toggle("badge-muted", !v.latest_published_plan_id);
  refreshStaleBanner();
}

function refreshStaleBanner() {
  const banner = $("#stale-banner");
  if (state.preview && state.preview.config_version !== state.version) {
    banner.textContent =
      `配置已变化（当前 v${state.version}，预览基于 v${state.preview.config_version}），请重新生成预览；旧预览无法发布。`;
    banner.classList.remove("hidden");
    $("#btn-publish").disabled = true;
  } else {
    banner.classList.add("hidden");
  }
}

// ---------- 型录 ----------
async function loadCatalog() {
  state.catalog = await api("/api/catalog");
  const list = $("#catalog-list");
  if (!state.catalog.length) {
    list.innerHTML = '<p class="muted">尚未导入任何型号。</p>';
  } else {
    list.innerHTML = state.catalog
      .map(
        (t) => `
      <div class="type-card">
        <div class="title">${esc(t.manufacturer)} ${esc(t.name)}
          <button class="danger" data-del-type="${t.id}" style="float:right;font-size:12px">删除型号</button>
        </div>
        <div>${t.modes
          .map((m) => `<span class="mode-chip">${esc(m.name)} · ${m.channels}ch</span>`)
          .join("")}</div>
      </div>`
      )
      .join("");
  }
  fillFixtureModeSelect();
}

$("#catalog-list").addEventListener("click", async (e) => {
  const id = e.target.dataset.delType;
  if (id && confirm("确认删除该型号及其全部模式？被灯具实例引用时将被拒绝。")) {
    try {
      await api(`/api/catalog/${id}`, { method: "DELETE" });
      toast("已删除", "success");
      await Promise.all([loadCatalog(), refreshVersion(), loadFixtures()]);
    } catch (err) {
      toast(err.message, "error");
    }
  }
});

const SAMPLE_CSV = `manufacturer,name,mode,channels
ACME,Solar 360,Basic,9
ACME,Solar 360,Extended,14
ACME,Solar 360,Full,22
BrightCo,MegaPar 200,3CH,3
BrightCo,MegaPar 200,8CH,8
BrightCo,MegaPar 200,11CH,11
LitePro,Beam 150,Standard,16
LitePro,Beam 150,Macro,20
StrobeKing,Storm 1k,Basic,2
StrobeKing,Storm 1k,DMX Pro,5`;

$("#btn-load-sample").addEventListener("click", () => {
  $("#catalog-text").value = SAMPLE_CSV;
});

async function importCatalogBody(body, isForm) {
  const opts = isForm ? { method: "POST", body } : { method: "POST", body: JSON.stringify(body) };
  const result = await api("/api/catalog/import", opts);
  $("#catalog-msg").innerHTML = `<span class="muted">新增型号 ${result.created_types}，更新型号 ${result.updated_types}，新增模式 ${result.created_modes}，更新模式通道数 ${result.updated_modes}</span>`;
  toast("型录导入成功", "success");
  await Promise.all([loadCatalog(), refreshVersion()]);
}

$("#catalog-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  try {
    await importCatalogBody(form, true);
    e.target.value = "";
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#btn-import-text").addEventListener("click", async () => {
  const text = $("#catalog-text").value.trim();
  if (!text) return toast("请先粘贴 CSV/JSON 内容", "error");
  try {
    let rows;
    if (text.startsWith("[") || text.startsWith("{")) {
      const parsed = JSON.parse(text);
      rows = Array.isArray(parsed) ? parsed : [parsed];
      await importCatalogBody(rows, false);
    } else {
      const form = new FormData();
      form.append("file", new Blob([text], { type: "text/csv" }), "catalog.csv");
      await importCatalogBody(form, true);
    }
  } catch (err) {
    toast(err.message, "error");
  }
});

// ---------- 灯具实例 ----------
function fillFixtureModeSelect() {
  const sel = $("#fixture-mode-select");
  const current = sel.value;
  sel.innerHTML = state.catalog
    .flatMap((t) =>
      t.modes.map(
        (m) =>
          `<option value="${m.id}">${esc(t.manufacturer)} ${esc(t.name)} / ${esc(m.name)} (${m.channels}ch)</option>`
      )
    )
    .join("");
  if (current) sel.value = current;
}

async function loadFixtures() {
  state.fixtures = await api("/api/fixtures");
  $("#fixture-count").textContent = state.fixtures.length;
  $("#fixture-tbody").innerHTML = state.fixtures
    .map(
      (f) => `
    <tr>
      <td>${f.id}</td>
      <td>${esc(f.name)}</td>
      <td>${esc(f.type_name || "-")}</td>
      <td>${esc(f.mode_name || "-")}</td>
      <td>${f.channels}</td>
      <td>${f.previous_line ?? "—"}</td>
      <td>${f.previous_start ?? "—"}</td>
      <td>${f.locked ? "🔒" : ""}</td>
      <td>
        <button data-edit="${f.id}">编辑</button>
        <button class="danger" data-del="${f.id}">删除</button>
      </td>
    </tr>`
    )
    .join("");
}

$("#fixture-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    name: fd.get("name").trim(),
    mode_id: Number(fd.get("mode_id")),
    previous_line: fd.get("previous_line") ? Number(fd.get("previous_line")) : null,
    previous_start: fd.get("previous_start") ? Number(fd.get("previous_start")) : null,
    locked: fd.get("locked") === "on",
  };
  try {
    await api("/api/fixtures", { method: "POST", body: JSON.stringify(body) });
    toast("灯具已添加", "success");
    e.target.reset();
    await Promise.all([loadFixtures(), refreshVersion()]);
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#fixture-tbody").addEventListener("click", async (e) => {
  const delId = e.target.dataset.del;
  const editId = e.target.dataset.edit;
  if (delId && confirm("确认删除该灯具实例？")) {
    try {
      await api(`/api/fixtures/${delId}`, { method: "DELETE" });
      toast("已删除", "success");
      await Promise.all([loadFixtures(), refreshVersion()]);
    } catch (err) {
      toast(err.message, "error");
    }
  } else if (editId) {
    const f = state.fixtures.find((x) => x.id === Number(editId));
    const name = prompt("灯具名称", f.name);
    if (name === null) return;
    const line = prompt("既有线路 (1-4，留空表示无)", f.previous_line ?? "");
    if (line === null) return;
    const start = prompt("既有起始地址 (1-512，留空表示无)", f.previous_start ?? "");
    if (start === null) return;
    const locked = confirm("确定 = 锁定到既有线路与地址；取消 = 不锁定");
    try {
      await api(`/api/fixtures/${editId}`, {
        method: "PUT",
        body: JSON.stringify({
          name: name.trim() || f.name,
          previous_line: line.trim() ? Number(line) : null,
          previous_start: start.trim() ? Number(start) : null,
          locked,
        }),
      });
      toast("已更新", "success");
      await Promise.all([loadFixtures(), refreshVersion()]);
    } catch (err) {
      toast(err.message, "error");
    }
  }
});

// ---------- 线路与保留区 ----------
async function loadLines() {
  state.lines = await api("/api/lines");
  $("#line-tbody").innerHTML = state.lines
    .map(
      (l) => `
    <tr>
      <td>${l.id}</td>
      <td><input value="${esc(l.name)}" data-line-name="${l.id}" style="width:180px" /></td>
      <td>
        <label class="switch">
          <input type="checkbox" data-line-active="${l.id}" ${l.is_active ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </td>
      <td><button data-line-save="${l.id}">保存</button></td>
    </tr>`
    )
    .join("");
  $("#res-line").innerHTML = state.lines
    .map((l) => `<option value="${l.id}">${l.id} - ${esc(l.name)}</option>`)
    .join("");
}

$("#line-tbody").addEventListener("click", async (e) => {
  const id = e.target.dataset.lineSave;
  if (!id) return;
  const name = $(`[data-line-name="${id}"]`).value;
  const isActive = $(`[data-line-active="${id}"]`).checked;
  try {
    await api(`/api/lines/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, is_active: isActive }),
    });
    toast("线路已更新", "success");
    await Promise.all([loadLines(), refreshVersion(), loadReservations()]);
  } catch (err) {
    toast(err.message, "error");
    await loadLines();
  }
});

async function loadReservations() {
  state.reservations = await api("/api/reservations");
  const lineName = Object.fromEntries(state.lines.map((l) => [l.id, l.name]));
  $("#reservation-tbody").innerHTML = state.reservations
    .map(
      (r) => `
    <tr>
      <td>${r.id}</td>
      <td>${r.line_id} - ${esc(lineName[r.line_id] || "")}</td>
      <td>${r.start}</td>
      <td>${r.end}</td>
      <td>${r.end - r.start + 1}</td>
      <td>${esc(r.reason)}</td>
      <td><button class="danger" data-del-res="${r.id}">删除</button></td>
    </tr>`
    )
    .join("");
}

$("#reservation-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    line_id: Number(fd.get("line_id")),
    start: Number(fd.get("start")),
    end: Number(fd.get("end")),
    reason: fd.get("reason") || "",
  };
  try {
    await api("/api/reservations", { method: "POST", body: JSON.stringify(body) });
    toast("保留区已添加", "success");
    e.target.reset();
    await Promise.all([loadReservations(), refreshVersion()]);
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#reservation-tbody").addEventListener("click", async (e) => {
  const id = e.target.dataset.delRes;
  if (id && confirm("确认删除该保留区？")) {
    try {
      await api(`/api/reservations/${id}`, { method: "DELETE" });
      toast("已删除", "success");
      await Promise.all([loadReservations(), refreshVersion()]);
    } catch (err) {
      toast(err.message, "error");
    }
  }
});

// ---------- 编排预览 ----------
$("#btn-preview").addEventListener("click", generatePreview);

async function generatePreview() {
  try {
    const result = await api("/api/plans/preview", { method: "POST" });
    // 只有逐级证明最优（optimal）的预览才可发布；未证最优结果不得进入发布流程。
    state.preview = result.feasible && result.optimality_status === "optimal" ? result : null;
    renderPreview(result);
    await refreshVersion();
  } catch (err) {
    toast(err.message, "error");
  }
}

function renderPreview(p) {
  const conflictPanel = $("#conflict-panel");
  const unprovenPanel = $("#unproven-panel");
  const migrationPanel = $("#migration-panel");
  const allocPanel = $("#alloc-panel");

  if (p.optimality_status === "unproven") {
    // 未证最优：一律不可发布。按是否取得完整可用排布（feasible）分两种展示——
    // 有候选：展示候选排布仅供参考；空候选：暂无可展示排布，且不当作已证无解。
    const hasCandidate = p.feasible && Array.isArray(p.allocations) && p.allocations.length > 0;
    unprovenPanel.classList.remove("hidden");
    $("#unproven-msg").textContent = p.message || "未能在限定时间内证明最优。";
    $("#unproven-detail").textContent = hasCandidate
      ? "求解器在限定时间内只找到可行候选，未能逐级证明“迁移台数最少 → 启用线路数最少 → 字典序最小”。下列排布仅供参考，未生成可发布草稿；请减少灯具数量或稍后重新生成预览。"
      : "求解器在限定时间内未取得任何可展示的候选排布（暂无可展示排布）。这不是已证明无解：约束可能仍有可行排布，只是本次求解未能取得。未生成草稿，也不能发布；请减少灯具数量、放宽部分锁定或稍后重新生成预览。";
    conflictPanel.classList.add("hidden");
    $("#btn-publish").disabled = true;
    if (hasCandidate) {
      allocPanel.classList.remove("hidden");
      $("#plan-summary").textContent =
        `候选预览（未证最优，不可发布）· 基于配置 v${p.config_version}` +
        ` · 迁移 ${p.migration_count} 台 · 启用 ${p.used_lines} 条线路`;
      renderTracks(p.occupancy);
      renderMigrations(p.migrations);
      renderAllocations(p.allocations);
    } else {
      migrationPanel.classList.add("hidden");
      allocPanel.classList.add("hidden");
      $("#tracks").innerHTML = "";
      $("#plan-summary").textContent =
        `暂无可展示排布（未证最优，未生成草稿）· 基于配置 v${p.config_version}`;
    }
    return;
  }

  unprovenPanel.classList.add("hidden");

  if (!p.feasible) {
    conflictPanel.classList.remove("hidden");
    migrationPanel.classList.add("hidden");
    allocPanel.classList.add("hidden");
    $("#tracks").innerHTML = "";
    $("#btn-publish").disabled = true;
    $("#plan-summary").textContent = "无可行方案";
    $("#conflict-list").innerHTML = p.conflicts
      .map((c) => `<li><strong>[${esc(c.type)}]</strong> ${esc(c.message)}</li>`)
      .join("");
    return;
  }

  conflictPanel.classList.add("hidden");
  allocPanel.classList.remove("hidden");
  $("#plan-summary").textContent =
    `预览 #${p.plan_id} · 基于配置 v${p.config_version} · ✅ 已逐级证明最优` +
    ` · 迁移 ${p.migration_count} 台 · 启用 ${p.used_lines} 条线路`;

  renderTracks(p.occupancy);
  renderMigrations(p.migrations);
  renderAllocations(p.allocations);

  const fresh = p.config_version === state.version;
  $("#btn-publish").disabled = !fresh;
}

function renderTracks(occupancy) {
  const pct = (addr) => `calc(${(addr - 1) / 512 * 100}%)`;
  const widthPct = (a, b) => `calc(${(b - a + 1) / 512 * 100}%)`;
  $("#tracks").innerHTML = occupancy
    .map((line) => {
      const resBlocks = line.reservations
        .map(
          (r) =>
            `<div class="block reserved" style="left:${pct(r.start)};width:${widthPct(r.start, r.end)}"
              title="保留区 #${r.id}：${r.start}-${r.end} ${esc(r.reason)}">保 #${r.id}</div>`
        )
        .join("");
      const fxBlocks = line.fixtures
        .map((f) => {
          const cls = f.locked ? "locked" : f.migrated ? "migrated" : "fixture";
          return `<div class="block ${cls}" style="left:${pct(f.start)};width:${widthPct(f.start, f.end)}"
            title="#${f.fixture_id} ${esc(f.name)}：${f.start}-${f.end}（${f.channels}ch）${f.locked ? " 🔒锁定" : f.migrated ? " 迁移" : ""}">
            ${f.channels >= 14 ? esc(f.name) : f.fixture_id}</div>`;
        })
        .join("");
      return `
      <div class="track ${line.is_active ? "" : "disabled"}">
        <div class="track-head">
          <strong>线路 ${line.line_id} · ${esc(line.name)}</strong>${line.is_active ? "" : "（已停用）"}
          <span class="muted">已用 ${line.used_channels}/512，空闲 ${line.free_channels}</span>
        </div>
        <div class="track-bar">${line.is_active ? resBlocks + fxBlocks : ""}</div>
        <div class="track-scale"><span>1</span><span>128</span><span>256</span><span>384</span><span>512</span></div>
      </div>`;
    })
    .join("");
}

function addrOr(v) {
  return v ?? "—";
}

function renderMigrations(migrations) {
  const panel = $("#migration-panel");
  $("#migration-count").textContent = migrations.length;
  if (!migrations.length) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  $("#migration-tbody").innerHTML = migrations
    .map(
      (m) => `
    <tr>
      <td>${m.fixture_id}</td><td>${esc(m.name)}</td>
      <td>${addrOr(m.from_line)}</td><td>${addrOr(m.from_start)}</td>
      <td>➡️</td>
      <td>${m.to_line}</td><td>${m.to_start}</td>
      <td>${m.locked ? "🔒" : ""}</td>
    </tr>`
    )
    .join("");
}

function renderAllocations(allocations) {
  $("#alloc-tbody").innerHTML = allocations
    .map(
      (a) => `
    <tr>
      <td>${a.fixture_id}</td><td>${esc(a.name)}</td>
      <td>${a.line_id}</td><td>${a.start}</td><td>${a.end}</td><td>${a.channels}</td>
      <td>${a.locked ? "🔒 锁定" : a.migrated ? "🟠 迁移" : "✅ 原位"}</td>
    </tr>`
    )
    .join("");
}

$("#btn-publish").addEventListener("click", async () => {
  if (!state.preview) return;
  if (state.preview.optimality_status !== "optimal") {
    toast("该预览未证明最优，不能发布", "error");
    return;
  }
  if (state.preview.config_version !== state.version) {
    toast("配置版本已过期，请重新生成预览", "error");
    return;
  }
  if (!confirm("确认按当前预览原子发布？发布后旧预览立即失效。")) return;
  try {
    const result = await api(`/api/plans/${state.preview.plan_id}/publish`, { method: "POST" });
    toast(`已发布 #${result.plan_id}（配置 v${result.config_version}）`, "success");
    state.preview = null;
    $("#plan-summary").textContent = "发布完成，可在“已发布”页签下载 CSV";
    $("#btn-publish").disabled = true;
    await Promise.all([refreshVersion(), loadFixtures()]);
    loadPublished();
  } catch (err) {
    toast(err.message, "error");
    await refreshVersion();
  }
});

// ---------- 已发布 ----------
// 名称来源标注：无快照旧记录的名称是当前值（current），灯具已删除则不可用
// （unavailable）；快照记录无该字段，名称即发布时事实，不加标注。
function publishedNameSuffix(source) {
  if (source === "current") return ' <span class="muted">（当前名称）</span>';
  if (source === "unavailable") return ' <span class="muted">（名称不可用）</span>';
  return "";
}

async function loadPublished() {
  const data = await api("/api/plans/published/latest");
  const empty = $("#published-empty");
  const content = $("#published-content");
  if (!data.has_published) {
    empty.classList.remove("hidden");
    content.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  content.classList.remove("hidden");
  await loadVerifyPlans();
  // 已发布地址表来自发布时的不可变快照：发布后改名、切换锁定、调整保留区
  // 都不会改变此表与 CSV；仅旧库缺少快照的记录按字段来源裁决重建并提示——
  // 名称标注“当前名称”，无法还原的锁定状态显示“未知”而非“否”。
  const legacy = data.from_snapshot === false;
  const when = new Date(data.published_at || data.created_at).toLocaleString("zh-CN");
  $("#published-meta").textContent =
    `发布 #${data.plan_id} · 配置 v${data.config_version} · ${when} · 迁移 ${data.migration_count} 台 · 启用 ${data.used_lines} 条线路`;
  const notice = $("#published-notice");
  if (legacy) {
    notice.textContent =
      data.notice || "该发布记录缺少快照：地址与迁移标记为发布时事实，名称为当前值，锁定/迁移起点/保留区占用未知。";
    notice.classList.remove("hidden");
  } else {
    notice.classList.add("hidden");
  }
  $("#btn-download-csv").href = `/api/plans/published/${data.plan_id}/csv`;
  // 除地址表外，同步渲染迁移清单与各线路占用块，供逐项核对
  renderPublishedTracks(data.occupancy || []);
  renderPublishedMigrations(data.migrations || []);
  $("#published-tbody").innerHTML = data.allocations
    .map((a) => {
      const nameSuffix = publishedNameSuffix(a.name_source);
      // locked 为 null 表示历史锁定状态无法还原：显示“未知”，不得当作未锁定
      const lockedCell = a.locked === null || a.locked === undefined ? "未知" : a.locked ? "🔒" : "";
      return `
    <tr>
      <td>${a.fixture_id}</td><td>${esc(a.name)}${nameSuffix}</td>
      <td>${a.line_id}</td><td>${a.start}</td><td>${a.end}</td><td>${a.channels}</td>
      <td>${a.migrated ? "🟠 是" : "否"}</td><td>${lockedCell}</td>
    </tr>`;
    })
    .join("");
}

// 已发布占用采用独立渲染，不复用预览的 renderTracks：预览组件要求 reservations
// 必为数组且停用线路不画块；而无快照旧记录的占用中 reservations 与含保留区的
// 已用/空闲数为 null（未知）、名称与线路启停是当前现状。若复用，旧记录的 null
// 会被当成“无保留区/零通道”、现状停用会隐藏发布时灯具块——两者都会改写历史
// 占用。独立渲染让旧记录的 null 与现状启停只以“未知/当前”标注呈现，快照记录
// 则照常显示完整快照值；预览路径行为完全不变。
function renderPublishedTracks(occupancy) {
  const pct = (addr) => `calc(${(addr - 1) / 512 * 100}%)`;
  const widthPct = (a, b) => `calc(${(b - a + 1) / 512 * 100}%)`;
  $("#published-tracks").innerHTML = occupancy
    .map((line) => {
      // 保留区无法还原（null）时不画保留块、不计入已用：显示“未知”，不得当作无保留区
      const resUnknown = line.reservations === null || line.reservations === undefined;
      const resBlocks = resUnknown
        ? ""
        : line.reservations
            .map(
              (r) =>
                `<div class="block reserved" style="left:${pct(r.start)};width:${widthPct(r.start, r.end)}"
                  title="保留区 #${r.id}：${r.start}-${r.end} ${esc(r.reason)}">保 #${r.id}</div>`
            )
            .join("");
      // 灯具块是发布时事实：线路后来停用（或当时停用）也必须画出，不得隐藏
      const fxBlocks = (line.fixtures || [])
        .map((f) => {
          // 历史锁定未知（null）时按普通灯具着色并标注“锁定未知”，不得当作未锁定；
          // 迁移标记是发布时事实，与锁定状态各自独立标注
          const lockedUnknown = f.locked === null || f.locked === undefined;
          const cls = f.locked ? "locked" : f.migrated ? "migrated" : "fixture";
          const stateTip =
            (f.migrated ? " 迁移" : "") + (lockedUnknown ? " 锁定未知" : f.locked ? " 🔒锁定" : "");
          const nameTip =
            f.name_source === "current" ? "（当前名称）" : f.name_source === "unavailable" ? "（名称不可用）" : "";
          return `<div class="block ${cls}" style="left:${pct(f.start)};width:${widthPct(f.start, f.end)}"
            title="#${f.fixture_id} ${esc(f.name)}${nameTip}：${f.start}-${f.end}（${f.channels}ch）${stateTip}">
            ${f.channels >= 14 ? esc(f.name) : f.fixture_id}</div>`;
        })
        .join("");
      // 线路名称与启停为当前现状时标注来源；启停是现状，不影响发布时灯具块的展示
      const lineNameSuffix = line.name_source === "current" ? ' <span class="muted">（当前名称）</span>' : "";
      const activeLabel = line.is_active
        ? line.is_active_source === "current"
          ? ' <span class="muted">（当前启用）</span>'
          : ""
        : line.is_active_source === "current"
          ? ' <span class="muted">（当前已停用）</span>'
          : "（已停用）";
      // 含保留区的已用/空闲无法还原（null）时显示“未知”，不得当作零；
      // 另给出仅灯具占用的事实部分（fixtures_used_channels）
      const size = line.size ?? 512;
      let usage;
      if (line.used_channels === null || line.used_channels === undefined) {
        usage = `已用 未知/${size}，空闲 未知`;
        if (line.fixtures_used_channels !== null && line.fixtures_used_channels !== undefined) {
          usage += `（其中灯具占用 ${line.fixtures_used_channels} 通道，为发布时事实）`;
        }
      } else {
        usage = `已用 ${line.used_channels}/${size}，空闲 ${line.free_channels}`;
      }
      const resNote = resUnknown ? " · 保留区：未知（无法还原）" : "";
      return `
      <div class="track ${line.is_active ? "" : "disabled"}">
        <div class="track-head">
          <strong>线路 ${line.line_id} · ${esc(line.name)}</strong>${lineNameSuffix}${activeLabel}
          <span class="muted">${usage}${resNote}</span>
        </div>
        <div class="track-bar">${resBlocks + fxBlocks}</div>
        <div class="track-scale"><span>1</span><span>128</span><span>256</span><span>384</span><span>512</span></div>
      </div>`;
    })
    .join("");
}

function renderPublishedMigrations(migrations) {
  const panel = $("#published-migration-panel");
  $("#published-migration-count").textContent = migrations.length;
  if (!migrations.length) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  $("#published-migration-tbody").innerHTML = migrations
    .map((m) => {
      const nameSuffix = publishedNameSuffix(m.name_source);
      // 迁移落点（新线路/新地址）是留存事实；起点无法还原（null）时显示“未知”，
      // 不得当作无起点；历史锁定未知时同样显示“未知”，不得当作未锁定
      const fromLine = m.from_line === null || m.from_line === undefined ? "未知" : m.from_line;
      const fromStart = m.from_start === null || m.from_start === undefined ? "未知" : m.from_start;
      const lockedCell = m.locked === null || m.locked === undefined ? "未知" : m.locked ? "🔒" : "";
      return `
    <tr>
      <td>${m.fixture_id}</td><td>${esc(m.name)}${nameSuffix}</td>
      <td>${fromLine}</td><td>${fromStart}</td>
      <td>➡️</td>
      <td>${m.to_line}</td><td>${m.to_start}</td>
      <td>${lockedCell}</td>
    </tr>`;
    })
    .join("");
}

// ---------- 现场地址核验 ----------
// 已发布方案选择器：可选择任一已发布版本，核验以该版本发布时的落点为基准，
// 灯具后来改名、删除或再次发布都不影响核验结果。
// 同一列表同时供 DMX 信号回放选择版本（回放同样以发布时落点为基准）。
async function loadVerifyPlans() {
  const plans = await api("/api/plans/published");
  const options = plans
    .map((p) => {
      const when = p.published_at ? new Date(p.published_at).toLocaleString("zh-CN") : "-";
      return `<option value="${p.plan_id}">发布 #${p.plan_id} · 配置 v${p.config_version} · ${when}</option>`;
    })
    .join("");
  $("#verify-plan-select").innerHTML = options;
  $("#replay-plan-select").innerHTML = options;
}

$("#btn-verify").addEventListener("click", async () => {
  const planId = $("#verify-plan-select").value;
  const file = $("#verify-file").files[0];
  if (!planId) return toast("请选择要核验的已发布方案", "error");
  if (!file) return toast("请选择现场 CSV 文件", "error");
  const form = new FormData();
  form.append("file", file);
  try {
    const report = await api(`/api/plans/${planId}/verify`, { method: "POST", body: form });
    renderVerifyReport(report);
  } catch (err) {
    $("#verify-result").innerHTML = "";
    toast(err.message, "error");
  }
});

const VERIFY_FIELD_LABELS = { line: "线路", start: "起始地址", channels: "通道数" };

// 渲染核验报告：整表结论横幅 + 逐项清单（隔离行/缺失/额外/不符/现场重叠）。
// 地址差异（不符清单）与跨行重叠（现场区间重叠）分开展示，互不混入。
function renderVerifyReport(r) {
  const box = $("#verify-result");
  const c = r.counts;
  let html = "";
  // 旧记录缺少快照时提示字段来源：名称/锁定/保留区不参与裁决
  if (r.notice) {
    html += `<div class="banner warn">${esc(r.notice)}</div>`;
  }
  const baselineNote = r.from_snapshot ? "发布快照" : "留存明细（无快照旧记录）";
  if (r.consistent) {
    html += `<div class="banner ok">✅ 整表一致：现场 ${c.checked} 台灯具与发布 #${r.plan_id}（基准：${baselineNote}）的落点完全一致。</div>`;
  } else {
    html += `<div class="banner err">❌ 整表不一致（基准：发布 #${r.plan_id}，${baselineNote}）——
      缺失 ${c.missing} 台 · 额外 ${c.extra} 台 · 线路/地址/通道不符 ${c.mismatched} 台 ·
      现场区间重叠 ${c.overlap_pairs} 处 · 隔离异常行 ${c.quarantined_rows} 行；
      已按 ID 对齐核对 ${c.checked} 台，其中 ${c.matched} 台一致。</div>`;
  }

  if (r.quarantined.length) {
    html += `
      <h3>⚠️ 隔离异常行 <span class="count">${r.quarantined.length}</span></h3>
      <p class="muted">以下行未参与对齐核对；只要存在隔离行，整表结论就不会是“一致”。</p>
      <table class="data">
        <thead><tr><th>行号</th><th>灯具ID</th><th>原始内容</th><th>隔离原因</th></tr></thead>
        <tbody>${r.quarantined
          .map(
            (q) => `<tr><td>${q.row}</td><td>${q.fixture_id ?? "—"}</td>
              <td><code>${esc(q.raw)}</code></td><td>${q.reasons.map(esc).join("；")}</td></tr>`
          )
          .join("")}</tbody>
      </table>`;
  }

  if (r.missing.length) {
    html += `
      <h3>📭 缺失（发布有、现场无）<span class="count">${r.missing.length}</span></h3>
      <table class="data">
        <thead><tr><th>灯具ID</th><th>名称</th><th>线路</th><th>起始</th><th>结束</th><th>通道数</th></tr></thead>
        <tbody>${r.missing
          .map(
            (m) => `<tr><td>${m.fixture_id}</td><td>${esc(m.name)}${publishedNameSuffix(m.name_source)}</td>
              <td>${m.line_id}</td><td>${m.start}</td><td>${m.end}</td><td>${m.channels}</td></tr>`
          )
          .join("")}</tbody>
      </table>`;
  }

  if (r.extra.length) {
    html += `
      <h3>➕ 额外（现场有、发布无）<span class="count">${r.extra.length}</span></h3>
      <table class="data">
        <thead><tr><th>行号</th><th>灯具ID</th><th>线路</th><th>起始</th><th>结束</th><th>通道数</th></tr></thead>
        <tbody>${r.extra
          .map(
            (x) => `<tr><td>${x.row}</td><td>${x.fixture_id}</td>
              <td>${x.line}</td><td>${x.start}</td><td>${x.end}</td><td>${x.channels}</td></tr>`
          )
          .join("")}</tbody>
      </table>`;
  }

  if (r.mismatches.length) {
    html += `
      <h3>🔀 线路/地址/通道不符 <span class="count">${r.mismatches.length}</span></h3>
      <table class="data">
        <thead><tr><th>灯具ID</th><th>名称</th><th>现场行号</th><th>差异项</th><th>发布落点</th><th>现场值</th></tr></thead>
        <tbody>${r.mismatches
          .flatMap((m) =>
            m.diffs.map(
              (d) => `<tr><td>${m.fixture_id}</td><td>${esc(m.name)}${publishedNameSuffix(m.name_source)}</td>
                <td>${m.row}</td><td>${VERIFY_FIELD_LABELS[d.field]}</td>
                <td>${d.expected}</td><td class="diff-bad">${d.actual}</td></tr>`
            )
          )
          .join("")}</tbody>
      </table>`;
  }

  if (r.overlaps.length) {
    html += `
      <h3>🧨 现场区间重叠 <span class="count">${r.overlaps.length}</span></h3>
      <p class="muted">同一线路上两台灯具的通道区间（闭区间）相交，与上方的地址差异无关，需现场排查。</p>
      <table class="data">
        <thead><tr><th>线路</th><th>灯具 A</th><th>区间 A</th><th>灯具 B</th><th>区间 B</th><th>重叠区间</th></tr></thead>
        <tbody>${r.overlaps
          .map(
            (o) => `<tr><td>${o.line}</td>
              <td>#${o.a.fixture_id}（行 ${o.a.row}）</td><td>${o.a.start}-${o.a.end}</td>
              <td>#${o.b.fixture_id}（行 ${o.b.row}）</td><td>${o.b.start}-${o.b.end}</td>
              <td class="diff-bad">${o.overlap_start}-${o.overlap_end}</td></tr>`
          )
          .join("")}</tbody>
      </table>`;
  }

  box.innerHTML = html;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- DMX 信号回放 ----------
// 回放视图状态：report 为服务端重建结果（帧 + 槽位归类）；values 为当前帧
// 之前的累积槽位读数（槽位初值 0，未更新的值延续上一帧）；idx 为当前帧下标。
const replayView = { report: null, idx: -1, values: new Map() };

$("#btn-replay").addEventListener("click", async () => {
  const planId = $("#replay-plan-select").value;
  const file = $("#replay-file").files[0];
  const policy = $("#replay-conflict-policy").value;
  if (!planId) return toast("请选择要回放的已发布方案", "error");
  if (!file) return toast("请选择信号 CSV 文件", "error");
  const form = new FormData();
  form.append("file", file);
  try {
    const report = await api(`/api/plans/${planId}/replay?on_conflict=${policy}`, {
      method: "POST",
      body: form,
    });
    replayView.report = report;
    replayView.idx = -1;
    replayView.values = new Map();
    renderReplayShell(report);
    if (report.counts.frames > 0) gotoReplayFrame(0);
  } catch (err) {
    replayView.report = null;
    $("#replay-result").innerHTML = "";
    toast(err.message, "error");
  }
});

// 渲染回放结果骨架：结论横幅、冲突标注、帧导航控件；帧内容见 renderReplayFrame。
function renderReplayShell(r) {
  const c = r.counts;
  let html = "";
  (r.notices || []).forEach((n) => {
    html += `<div class="banner warn">${esc(n)}</div>`;
  });
  const baseNote = r.from_snapshot
    ? "发布快照（含发布时保留区）"
    : "留存明细（无快照旧记录，灯具外归属未知）";
  html += `<div class="banner ok">🎞️ 已重建 ${c.frames} 帧：${c.rows} 行信号，触及 ${c.slots_touched} 个槽位、
    ${c.fixtures_touched} 台灯具（基准：发布 #${r.plan_id}，${baseNote}）。
    槽位初值 0，未更新的值延续上一帧。</div>`;

  if (r.conflicts_resolved && r.conflicts_resolved.length) {
    html += `
      <h3>⚠️ 同毫秒同槽冲突（已按文件顺序取末值）<span class="count">${r.conflicts_resolved.length}</span></h3>
      <table class="data">
        <thead><tr><th>时间(ms)</th><th>线路</th><th>通道</th><th>涉及行</th><th>出现值</th><th>采用值</th></tr></thead>
        <tbody>${r.conflicts_resolved
          .map(
            (k) => `<tr><td>${k.t}</td><td>${k.line}</td><td>${k.channel}</td>
              <td>${k.rows.join(", ")}</td><td>${k.values.join(" → ")}</td>
              <td class="diff-bad">${k.taken}</td></tr>`
          )
          .join("")}</tbody>
      </table>`;
  }

  if (!c.frames) {
    html += `<p class="muted">CSV 中没有数据行，未产生任何帧。</p>`;
    $("#replay-result").innerHTML = html;
    return;
  }

  html += `
    <div class="replay-controls">
      <button id="replay-first" title="第一帧">⏮</button>
      <button id="replay-prev">◀ 上一帧</button>
      <input type="range" id="replay-slider" min="0" max="${c.frames - 1}" value="0" />
      <button id="replay-next">下一帧 ▶</button>
      <button id="replay-last" title="最后一帧">⏭</button>
      <span id="replay-frame-label" class="replay-frame-label"></span>
    </div>
    <div id="replay-frame-view"></div>`;
  $("#replay-result").innerHTML = html;
  $("#replay-first").addEventListener("click", () => gotoReplayFrame(0));
  $("#replay-prev").addEventListener("click", () => gotoReplayFrame(replayView.idx - 1));
  $("#replay-next").addEventListener("click", () => gotoReplayFrame(replayView.idx + 1));
  $("#replay-last").addEventListener("click", () => gotoReplayFrame(r.counts.frames - 1));
  $("#replay-slider").addEventListener("input", (e) => gotoReplayFrame(Number(e.target.value)));
}

// 跳转到第 i 帧：前进时逐帧累积，回退时从第 0 帧重放，保证读数与逐帧推进一致。
function gotoReplayFrame(i) {
  const r = replayView.report;
  if (!r || !r.frames.length) return;
  i = Math.max(0, Math.min(r.frames.length - 1, i));
  if (i < replayView.idx) {
    replayView.values = new Map();
    replayView.idx = -1;
  }
  for (let f = replayView.idx + 1; f <= i; f++) {
    for (const ch of r.frames[f].changes) {
      replayView.values.set(`${ch.line}:${ch.channel}`, ch.value);
    }
  }
  replayView.idx = i;
  renderReplayFrame();
}

// 渲染当前帧：按灯具展示相对通道读数（高亮本帧变化）及变化清单；
// 有快照时列出保留区与未分配通道的非零值，旧记录列出灯具外归属未知的非零值。
function renderReplayFrame() {
  const r = replayView.report;
  const frame = r.frames[replayView.idx];
  $("#replay-slider").value = replayView.idx;
  $("#replay-frame-label").textContent =
    `第 ${replayView.idx + 1}/${r.counts.frames} 帧 · t=${frame.t} ms · 本帧更新 ${frame.changes.length} 个槽位`;

  const changedKeys = new Set(frame.changes.map((c) => `${c.line}:${c.channel}`));
  const regionOf = (key) => r.slot_regions[key] || { kind: "unknown" };

  // 本帧变化按灯具分组（相对通道），灯具外的变化归入保留区/未分配/未知
  const changesByFixture = new Map();
  for (const c of frame.changes) {
    const reg = regionOf(`${c.line}:${c.channel}`);
    if (reg.kind === "fixture") {
      if (!changesByFixture.has(reg.fixture_id)) changesByFixture.set(reg.fixture_id, []);
      changesByFixture.get(reg.fixture_id).push({ ...c, rel: reg.rel_channel });
    }
  }

  const touched = new Set(r.fixtures_touched);
  let html = "";
  for (const f of r.fixtures) {
    if (!touched.has(f.fixture_id)) continue;
    const cells = [];
    for (let k = 1; k <= f.channels; k++) {
      const key = `${f.line_id}:${f.start + k - 1}`;
      const v = replayView.values.get(key) || 0;
      const cls = ["ch-cell"];
      if (changedKeys.has(key)) cls.push("changed");
      if (v !== 0) cls.push("nonzero");
      cells.push(
        `<span class="${cls.join(" ")}" title="相对通道 ${k}（线路 ${f.line_id} 通道 ${f.start + k - 1}）：${v}">${k}·${v}</span>`
      );
    }
    const chg = (changesByFixture.get(f.fixture_id) || [])
      .map((c) => `ch${c.rel}: ${c.previous}→${c.value}`)
      .join("，");
    html += `
      <div class="replay-fixture">
        <div class="replay-fixture-head">
          <strong>#${f.fixture_id} ${esc(f.name)}</strong>${publishedNameSuffix(f.name_source)}
          <span class="muted">线路 ${f.line_id} · ${f.start}-${f.end}（${f.channels}ch）</span>
        </div>
        <div class="ch-grid">${cells.join("")}</div>
        <div class="muted replay-changes">${chg ? `本帧变化：${esc(chg)}` : "本帧无变化"}</div>
      </div>`;
  }
  const untouched = r.fixtures.length - touched.size;
  if (untouched > 0) {
    html += `<p class="muted">另有 ${untouched} 台灯具全程无信号（读数恒为 0），未展开。</p>`;
  }

  // 保留区/未分配（快照）或灯具外归属未知（旧记录）的非零值：按当前帧累积读数列出
  if (r.from_snapshot) {
    html += replayRegionList("🚧 保留区非零值", "reserved", changedKeys);
    html += replayRegionList("⬚ 未分配通道非零值", "unallocated", changedKeys);
  } else {
    html += replayRegionList("❓ 灯具之外的非零值（归属未知）", "unknown", changedKeys);
  }
  $("#replay-frame-view").innerHTML = html;
}

// 列出某类区域在当前帧的非零槽位读数；本帧更新的槽位加粗标注。
function replayRegionList(title, kind, changedKeys) {
  const r = replayView.report;
  const items = [];
  for (const [key, reg] of Object.entries(r.slot_regions)) {
    if (reg.kind !== kind) continue;
    const v = replayView.values.get(key) || 0;
    if (v === 0) continue;
    const [line, channel] = key.split(":");
    const reason = reg.reason ? `（${reg.reason}）` : "";
    const text = `线路 ${line} 通道 ${channel} = ${v}${reason}`;
    items.push(changedKeys.has(key) ? `<strong>${esc(text)}</strong>` : esc(text));
  }
  return (
    `<h3>${title} <span class="count">${items.length}</span></h3>` +
    (items.length
      ? `<p class="replay-region-list">${items.join("；")}</p>`
      : `<p class="muted">本帧无。</p>`)
  );
}

// ---------- 启动 ----------
(async function init() {
  try {
    await Promise.all([loadCatalog(), loadFixtures(), loadLines(), refreshVersion()]);
    await loadReservations();
  } catch (err) {
    toast("初始化失败：" + err.message, "error");
  }
})();
