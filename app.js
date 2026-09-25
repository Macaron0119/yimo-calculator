/* 伊莫家園生產計算器 前端邏輯(純前端: 本地引擎 + localStorage) */
import { getEngine, getGameData } from "./engine/client.js";
import { store } from "./engine/store.js";

"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const fmt = (n) =>
  n == null || isNaN(n) ? "—" :
  Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
const fmt1 = (n) =>
  n == null || isNaN(n) ? "—" :
  Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 1 });

/* 高區分度配色: 相鄰色相/明度差異大, 白字對比均≥4.5:1 */
const PALETTE = ["#1D4ED8", "#C2410C", "#0F766E", "#7C3AED", "#BE185D",
  "#4D7C0F", "#92400E", "#0E7490", "#6D28D9", "#B91C1C", "#475569",
  "#A16207", "#15803D", "#86198F", "#9A3412", "#1E3A8A"];
const colorCache = {};
const colorOf = (label) => {
  if (!(label in colorCache))
    colorCache[label] = PALETTE[Object.keys(colorCache).length % PALETTE.length];
  return colorCache[label];
};
/* 背景色上用黑字還是白字(相對亮度) */
const inkOn = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 165 ? "#1F2937" : "#FFFFFF";
};

const state = {
  level: null, hours: 24, coeff: 1.0,
  buildings: [], recipes: [], stock: {}, buildingEff: {},
  pins: [],
  products: [], prodSort: { k: "net_per_hour", dir: -1 },
  lastResult: null,
  creatures: [], formLabels: {},
};

/* 與後端 unique_label 一致的配方顯示名(同名碰撞時高產版加"高速", 不顯示等級)*/
function recipeLabel(r) {
  const sibs = state.recipes.filter((x) => x.building === r.building && x.name === r.name);
  if (new Set(sibs.map((x) => x.output_qty)).size < 2)
    return r.name;
  const rate = (x) => {
    const t = x.grow_time_sec != null ? x.grow_time_sec : x.workload;
    return t ? x.output_qty / t : x.output_qty;
  };
  const mx = Math.max(...sibs.map(rate));
  const top = sibs.filter((x) => rate(x) === mx);
  return top.length === 1 && top[0].id === r.id ? `${r.name}(高速)` : r.name;
}

/* ---------------- 工具 ---------------- */
function chart(id) {
  const el = $("#" + id);
  if (!el.__chart) el.__chart = echarts.init(el);
  return el.__chart;
}
window.addEventListener("resize", () =>
  $$(".chart").forEach((el) => el.__chart && el.__chart.resize()));

function showError(msg) {
  const b = $("#error-banner");
  b.textContent = msg;
  b.classList.toggle("hidden", !msg);
}

function levelValue() {
  const v = parseInt($("#level").value, 10);
  return isNaN(v) ? null : v;
}
function collectCounts() {
  const out = {};
  $$("#building-editor input").forEach((i) => {
    const v = parseInt(i.value, 10);
    out[i.dataset.b] = isNaN(v) ? 0 : v;
  });
  return out;
}
function coeffValue() {
  const v = parseFloat($("#coeff").value);
  return (isNaN(v) ? 100 : v) / 100;
}
function hoursValue() {
  const sel = $("#hours").value;
  if (sel !== "custom") return parseFloat(sel);
  const v = parseFloat($("#hours-custom").value);
  return isNaN(v) ? 24 : v;
}
function switchValue() {
  return $("#opt-lazy").checked ? parseInt($("#max-switch").value, 10) : 0;
}
function recipesValue() {
  if (!$("#opt-lazy").checked) return null;
  const v = $("#max-recipes").value;
  return v === "" ? null : parseInt(v, 10);
}
/* ---------------- 最優方案 ---------------- */
async function runOptimize() {
  const btn = $("#btn-run");
  btn.disabled = true; btn.textContent = "計算中…";
  showError("");
  try {
    let pinData;
    try { pinData = collectPinRows(); }
    catch (e) { showError(e.message); return; }
    await new Promise((r) => setTimeout(r, 30));   // 讓"計算中"先渲染
    const engine = await getEngine();
    const result = await engine.optimize({
      level: levelValue(),
      hours: hoursValue(),
      coeff: coeffValue(),
      counts: collectCounts(),
      excludeSeasonal: !$("#opt-use-seasonal").checked,
      lazy: $("#opt-lazy").checked,
      maxSwitches: switchValue(),
      maxRecipes: recipesValue(),
      stock: collectStockRows(),
      buildingEff: collectEffRows(),
      pins: pinData,
    });
    if (!result.ok) throw new Error(result.message);
    state.lastResult = result;
    state.level = levelValue(); state.hours = result.hours;
    renderOverview(result);
    renderArrangement(result);
    renderSellChart(result);
    renderNetChart(result);
    renderPinUsed(result);
    renderStockUsed(result);
    renderPlanTable(result);
    renderFlows(result);
    renderExcluded(result);
  } catch (e) {
    showError("計算失敗: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "計算最優方案";
  }
}

function renderOverview(r) {
  $("#ov-lp").textContent = fmt(r.total_lp);
  $("#ov-int").textContent = fmt(r.total_int);
  $("#ov-int-k").textContent = r.lazy ? "懶人方案總價值" : "整數可行方案";
  $("#ov-ratio").textContent = r.lazy
    ? (r.segments && r.segments.length > 1
        ? `分 ${r.segments.length} 時段（統一切換）`
        : switchValue() > 0 ? "未觸發切換（全程一種配方較優）" : "每個建築全程不換配方")
    : `達成率 ${(r.ratio * 100).toFixed(2)}%（輪次取整後）`;
  const lazyDesc = r.lazy
    ? ` · 懶人模式${switchValue() > 0 ? `(原料類最多換${switchValue()}次)` : ""}` +
      (recipesValue() ? ` · 原料類≤${recipesValue()}種` : "")
    : "";
  const effDesc = Object.keys(r.building_eff || {}).length
    ? ` · 精細效率${Object.keys(r.building_eff).length}項` : "";
  const pinDesc = r.pins && r.pins.length
    ? ` · 自訂${r.pins.length}項` : "";
  $("#ov-cond").textContent =
    `等級${r.level == null ? "不限" : r.level} · ${r.hours}h · ` +
    `運作率${(r.work_coefficient * 100).toFixed(0)}%` +
    `${$("#opt-use-seasonal").checked ? " · 含賽季配方" : ""}` +
    lazyDesc + effDesc + pinDesc +
    `${Object.keys(r.stock || {}).length ? " · 含存量" : ""}`;
  $("#ov-kinds").textContent = r.sells.length;
  $("#ov-top").textContent = r.sells.length
    ? `價值最高: ${r.sells[0].item} ${fmt(r.sells[0].value)}`
    : "";
  $("#ov-bn-k").textContent = "平均每小時淨利潤";
  $("#ov-bn").textContent = r.total_int ? fmt(r.total_int / r.hours) : "—";
  $("#ov-bn2").textContent = `總淨利潤 ${fmt(r.total_int)} ÷ ${r.hours}h`;
}

/* 各產物淨利: 僅計實際出售的盈餘價值, 中間產物自耗不計收益 */
function netAgg(r) {
  return r.sells
    .map((s) => ({ label: s.item, qty: s.surplus,
                   net: s.value, perHour: s.value / r.hours }))
    .sort((x, y) => y.net - x.net);
}

/* ---------------- 種植與生產安排 ---------------- */
/* 秒 -> "40分鐘" / "2分42秒" / "6小時46分" */
function timeStr(sec) {
  sec = Math.round(sec);
  if (sec < 90) return `${sec}秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? `${m}分${s}秒` : `${m}分鐘`;
  }
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return m ? `${h}小時${m}分` : `${h}小時`;
}

/* 種植類: 輪次拆成 "X塊×Y輪·Z時長" 的整數安排(每組並行, 各顯各自時長) */
function growSplit(batches, cycles) {
  const full = Math.floor(batches / cycles);
  const rem = batches % cycles;
  const parts = [];
  if (full > 0) parts.push({ blocks: full, cycles });
  if (rem > 0) parts.push({ blocks: 1, cycles: rem });
  return { parts, slots: full + (rem > 0 ? 1 : 0) };
}
/* "8塊×36輪·24小時＋1塊×1輪·40分鐘" */
function growPartsStr(g, timePerBatch) {
  return g.parts.map((pt) =>
    `${pt.blocks}塊×${pt.cycles}輪·${timeStr(pt.cycles * timePerBatch)}`)
    .join("＋");
}
/* ---------------- 地塊甘特圖(田地/林地): 每塊地一行的時間軸 ---------------- */
const GANTT_BUILDINGS = new Set(["田地", "林地"]);

/* 把方案輪次落到每塊地:
   普通模式 —— 最少換茬貪心: 作物依計畫順序裝入"遊標最早"的地,
   整塊裝滿, 零頭地由後續作物接續;
   懶人分時段 —— 依各時段實例數直接分配, 同作物盡量黏在同一塊地 */
function ganttData(r, building) {
  const T = r.hours * 3600;
  const u = r.utilization.find(x => x.building === building);
  const count = u ? u.count : 0;
  if (!count) return null;
  const rows = Array.from({ length: count }, () => ({ cursor: 0, segs: [] }));
  if (r.segments && r.segments.length > 1) {
    const owner = new Map();               // label -> [rowIdx]
    for (const seg of r.segments) {
      const items = seg.buildings[building] || [];
      const need = new Map(items.map(x => [x.label, x.instances]));
      if (items.reduce((sm, x) => sm + x.instances, 0) > count) return null;
      for (const [label, idxs] of owner) {   // 回收多餘地塊
        const keep = need.get(label) || 0;
        while (idxs.length > keep) idxs.pop();
      }
      const occupied = new Set([...owner.values()].flat());
      const free = rows.map((_, i) => i).filter(i => !occupied.has(i));
      for (const [label, inst] of need) {
        let have = (owner.get(label) || []).length;
        if (!owner.has(label)) owner.set(label, []);
        while (have < inst) {
          const i = free.shift();
          if (i == null) return null;
          owner.get(label).push(i);
          have++;
        }
      }
      const s0 = seg.start_h * 3600, s1 = seg.end_h * 3600;
      for (const [label, idxs] of owner)
        for (const i of idxs) {
          rows[i].segs.push({ label, from: s0, to: s1 });
          rows[i].cursor = s1;
        }
    }
    return { rows, T, count };
  }
  const items = r.plan.filter(p => p.building === building &&
    p.ttype === "生長" && p.batches_int > 0);
  if (!items.length) return null;
  for (const it of items) {
    let rem = it.batches_int;
    const t = it.time_per_batch;
    while (rem > 0) {
      let best = -1;
      for (let i = 0; i < count; i++) {
        if (T - rows[i].cursor < t) continue;
        if (best < 0 || rows[i].cursor < rows[best].cursor) best = i;
      }
      if (best < 0) break;                 // 容差內放不下的尾差忽略
      const take = Math.min(rem, Math.floor((T - rows[best].cursor) / t));
      const row = rows[best];
      row.segs.push({ label: it.label, from: row.cursor,
        to: row.cursor + take * t, cycles: take });
      row.cursor += take * t;
      rem -= take;
    }
  }
  return { rows, T, count };
}
function renderGantt(r, building) {
  const g = ganttData(r, building);
  if (!g || !g.rows.some(rw => rw.segs.length)) return "";
  const T = g.T;
  const stepH = r.hours <= 6 ? 2 : r.hours <= 24 ? 6 : 12;
  const ticks = [];
  for (let h = 0; h < r.hours - 1e-6; h += stepH) ticks.push(h);
  ticks.push(r.hours);
  const rowsHtml = g.rows.map((rw, i) => {
    const segs = rw.segs.map(sg => {
      const w = (sg.to - sg.from) / T * 100;
      const c = colorOf(sg.label);
      const txt = w > 13 ? `${sg.label}·${timeStr(sg.to - sg.from)}`
        : w > 5.5 ? sg.label : "";
      return `<div class="g-seg${w <= 13 && w > 5.5 ? " brief" : ""}" ` +
        `style="left:${sg.from / T * 100}%;width:${w}%;` +
        `background:${c};color:${inkOn(c)}" ` +
        `title="${sg.label}${sg.cycles ? " " + sg.cycles + "輪" : ""} · ${timeStr(sg.from)}起 ${timeStr(sg.to - sg.from)}">${txt}</div>`;
    }).join("");
    return `<div class="g-row"><span class="g-lbl">${i + 1}號</span>` +
      `<div class="g-track">${segs}</div></div>`;
  }).join("");
  const collapsed = g.count > 14;
  return `<div class="gantt"><div class="g-head">${building} · ${g.count} 塊 · 逐塊時間軸` +
    `<span class="hint">${r.segments && r.segments.length > 1
      ? "以懶人分時段方案繪製" : "最少換茬的一種可行排布"}</span></div>` +
    `<div class="g-axis">${ticks.map(h =>
      `<span style="left:${h / r.hours * 100}%">${h % 1 ? (+h).toFixed(1) : h}h</span>`).join("")}</div>` +
    `<div class="g-rows${collapsed ? " collapsed" : ""}">${rowsHtml}</div>` +
    `${collapsed ? `<button class="g-toggle" type="button">展開全部 ${g.count} 塊</button>` : ""}</div>`;
}
function bindGanttToggles(scope) {
  scope.querySelectorAll(".g-toggle").forEach(btn => {
    btn.onclick = () => {
      btn.previousElementSibling.classList.remove("collapsed");
      btn.remove();
    };
  });
}

function renderArrangement(r) {
  const body = $("#arr-body");
  const hint = $("#arr-hint");
  const T = r.hours * 3600;

  if (r.segments && r.segments.length > 1) {
    // 分時段: 時間軸表格 (所有建築統一切換)
    hint.textContent =
      `懶人模式 · 全程分 ${r.segments.length} 時段，所有建築在 ` +
      r.segments.slice(1).map((s) => `第 ${s.start_h} 小時`).join(" 和 ") + " 統一換配方。";
    const segs = r.segments;
    let html = "";
    for (const b of ["田地", "林地"]) html += renderGantt(r, b);
    html += `<table class="seg-table"><thead><tr><th>建築</th>`;
    for (const s of segs)
      html += `<th>${fmt1(s.start_h)} – ${fmt1(s.end_h)} 小時</th>`;
    html += `</tr></thead><tbody>`;
    const bNames = [...new Set(segs.flatMap((s) => Object.keys(s.buildings)))];
    for (const b of bNames) {
      const cnt = r.utilization.find((u) => u.building === b)?.count ?? "";
      html += `<tr><td><b>${b}</b><br><span class="hint">${cnt} 座</span></td>`;
      for (const s of segs) {
        const items = s.buildings[b];
        html += `<td>${items
          ? items.map((x) =>
              `<span style="white-space:nowrap"><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colorOf(x.label)}"></span>` +
              `${x.label} <b>${x.instances}</b>${x.unit}·${fmt(x.batches)}輪</span>`).join("<br>")
          : `<span class="hint">閒置</span>`}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;
    html = `<div class="table-wrap">${html}</div>`;
    // 製造類建築不受切換限制, 單獨列出
    const flex = r.plan.filter((p) => p.flexible);
    if (flex.length) {
      html += `<div class="mt arr-b"><div class="arr-head">製造類建築` +
        `<span class="cap">材料到了就加工 · 全程靈活換配方</span></div>` +
        `<div class="arr-items">` +
        flex.map((p) =>
          `<span class="it"><span class="dot" style="background:${colorOf(p.label)}"></span>` +
          `<b>${p.seasonal ? "★" : ""}${p.building}·${p.label}</b> ` +
          `${fmt(p.batches)}輪（單輪${timeStr(p.time_per_batch)}）</span>`).join("") +
        `</div></div>`;
    }
    body.innerHTML = html;
    bindGanttToggles(body);
    return;
  }

  // 全程單段: 每建築比例條 + 整數口徑明細
    hint.textContent = r.lazy
      ? (r.max_recipes
        ? `原料建築最多 ${r.max_recipes === 1 ? "一" : r.max_recipes} 種產物，自訂生產不佔額；製造建築不限。`
        : "原料建築每塊地全程一種產物；製造建築不限。")
      : "如 9塊×18輪＋1塊×12輪：9 塊地各種 18 輪，另 1 塊種 12 輪。";
  const capBy = {};
  r.utilization.forEach((u) => (capBy[u.building] = u.cap));
  const order = [...r.utilization].sort((a, b) => b.pct - a.pct);
  const byB = {};
  for (const p of r.plan) (byB[p.building] = byB[p.building] || []).push(p);

  let html = "";
  for (const u of order) {
    const ps = byB[u.building];
    if (!ps || !ps.length) continue;
    html += `<div class="arr-b"><div class="arr-head">${u.building}` +
      `<span class="cap">${u.count} ${ps[0].unit === "地塊" ? "塊田" : "座"} · ` +
      `利用率 ${(u.pct * 100).toFixed(0)}%</span></div>`;
    if (GANTT_BUILDINGS.has(u.building))
      html += renderGantt(r, u.building);
    html += `<div class="arr-bar">`;
    for (const p of ps) {
      const share = Math.min(1, (p.batches_int * p.time_per_batch) / (capBy[u.building] || 1));
      if (share <= 0.0005) continue;
      const slotsInt = p.ttype === "生長"
        ? growSplit(p.batches_int, Math.floor(T / p.time_per_batch)).slots
        : (p.flexible || p.slots == null ? null : Math.max(1, Math.round(p.slots || 1)));
      const bg = colorOf(p.label);
      const label = share > 0.07
        ? `${p.label}${slotsInt ? ` ${fmt(slotsInt)}${p.unit}` : ""}` : "";
      html += `<div class="seg" style="width:${(share * 100).toFixed(2)}%;` +
        `background:${bg};color:${inkOn(bg)}" ` +
        `title="${p.label} ${(share * 100).toFixed(1)}%">${label}</div>`;
    }
    html += `</div><div class="arr-items">`;
    for (const p of ps) {
      if (!p.flexible && p.batches_int <= 0) continue;
      let txt;
      if (p.ttype === "生長") {
        const cycles = Math.floor(T / p.time_per_batch);
        const g = growSplit(p.batches_int, cycles);
        txt = `${growPartsStr(g, p.time_per_batch)}（每輪${timeStr(p.time_per_batch)}，共${fmt(p.batches_int)}輪）`;
      } else if (p.chain) {
        txt = `${fmt(p.batches)}輪（單輪${timeStr(p.time_per_batch)}，加工鏈環節）`;
      } else if (p.flexible) {
        txt = `${fmt(p.batches)}輪（單輪${timeStr(p.time_per_batch)}，` +
          `累計${timeStr(p.batches * p.time_per_batch)}，按材質靈活換配方）`;
      } else {
        txt = `${fmt(p.batches_int)}輪（單輪${timeStr(p.time_per_batch)}，` +
          `累計${timeStr(p.batches_int * p.time_per_batch)}` +
          `${r.lazy ? `，峰值${fmt(p.slots)}座` : ""}）`;
      }
      html += `<span class="it"><span class="dot" style="background:${colorOf(p.label)}"></span>` +
        `<b>${p.seasonal ? "★" : ""}${p.label}</b> ${txt}</span>`;
    }
    html += `</div></div>`;
  }
  body.innerHTML = html ||
    `<div class="hint">在當前條件下沒有需要安排的生產。</div>`;
  bindGanttToggles(body);
}

/* ---------------- 圖表 ---------------- */
function renderSellChart(r) {
  chart("chart-sell").setOption({
    color: PALETTE,
    tooltip: { trigger: "item", formatter: (p) =>
      `${p.name}<br/>${fmt(p.value)}（${p.percent}%）` },
    legend: { type: "scroll", orient: "vertical", right: 0, top: "middle",
      textStyle: { fontSize: 11, color: "#334155" } },
    series: [{
      type: "pie", radius: ["42%", "70%"], center: ["38%", "50%"],
      itemStyle: { borderRadius: 4, borderColor: "#fff", borderWidth: 2 },
      label: { formatter: "{b}\n{d}%", fontSize: 11, color: "#334155" },
      data: r.sells.map((s) => ({ name: s.item, value: Math.round(s.value) })),
    }],
  }, true);
}

/* 橫向長條圖通用繪製(產物淨利) */
function renderHBar(elId, rows, valueKey) {
  const el = $("#" + elId);
  el.style.height = Math.max(300, rows.length * 28 + 46) + "px";
  if (el.__chart) { el.__chart.dispose(); el.__chart = null; }
  el.__chart = echarts.init(el);
  el.__chart.setOption({
    tooltip: { trigger: "item", formatter: (p) => {
      const d = rows[p.dataIndex];
      return `<b>${d.label}</b><br/>淨利潤 ${fmt(d.net)}<br/>` +
        `每小時 ${fmt(d.perHour)}<br/>出售 ${fmt(d.qty)}`;
    } },
    grid: { left: 8, right: 78, top: 6, bottom: 4, containLabel: true },
    xAxis: { type: "value",
      axisLabel: { formatter: (v) => fmtCompact(v), color: "#334155" },
      splitLine: { lineStyle: { color: "#E2E8F0" } } },
    yAxis: { type: "category", data: rows.map((x) => x.label),
      axisLabel: { fontSize: 11, color: "#334155" } },
    series: [{
      type: "bar",
      data: rows.map((x) => ({
        value: Math.round(x[valueKey]),
        itemStyle: { color: colorOf(x.label), borderRadius: [0, 3, 3, 0] },
      })),
      barMaxWidth: 13,
      label: { show: true, position: "right", fontSize: 10, color: "#334155",
        formatter: (p) => fmtCompact(p.value) },
    }],
  });
}

/* 數值緊湊格式: 34.5萬 / 1,234 */
function fmtCompact(v) {
  v = Number(v);
  if (Math.abs(v) >= 10000)
    return (v / 10000).toFixed(v % 10000 === 0 ? 0 : 1) + "萬";
  return v.toLocaleString("zh-CN");
}

function renderNetChart(r) {
  const rows = netAgg(r).reverse();          // 倒序供橫向條形自下而上
  $("#net-title").innerHTML =
    `產物淨利潤（${r.hours} 小時內）` +
    `<span class="hint">只計實際賣出的部分，自用材料不計</span>`;
  renderHBar("chart-net", rows, "net");
}

function renderRankChart() {
  const rows = state.products
    .filter((p) => p.available && p.net_per_hour != null)
    .sort((a, b) => b.net_per_hour - a.net_per_hour)
    .slice(0, 15)
    .reverse()
    .map((p) => ({ ...p,
      matstr: (p.materials || []).map((m) => `${m.item}×${m.qty ?? "?"}`).join("、") }));
  chart("chart-rank").setOption({
    tooltip: { formatter: (p) => {
      const r = rows[p.dataIndex];
      const mats = (r.materials || []).map((m) =>
        `${m.item}×${m.qty ?? "?"}（${fmt(m.cost)}）`).join("<br/>");
      return `<b>${r.label}</b>（${r.building}）<br/>淨收益 ${fmt(r.net_per_hour)}/小時` +
        `<br/>單輪淨收益 ${fmt(r.net)} · ${fmt1(r.time)}s<br/>材料：<br>${mats || "無"}`;
    } },
    grid: { left: 6, right: 72, top: 8, bottom: 2, containLabel: true },
    xAxis: { type: "value",
      axisLabel: { formatter: (v) => fmtCompact(v), color: "#334155" } },
    yAxis: { type: "category", data: rows.map((r) => r.label),
      axisLabel: { fontSize: 11, color: "#334155" } },
    series: [{
      type: "bar",
      data: rows.map((r) => ({
        value: Math.round(r.net_per_hour),
        itemStyle: { color: colorOf(r.label), borderRadius: [0, 3, 3, 0] },
      })),
      label: { show: true, position: "right", fontSize: 10, color: "#334155",
        formatter: (p) => fmtCompact(p.value) },
      barMaxWidth: 14,
    }],
  }, true);
}

/* ---------------- 方案明細表 ---------------- */
function renderPlanTable(r) {
  const tbody = $("#plan-table tbody");
  const groups = new Map();
  for (const p of r.plan) {
    if (!groups.has(p.building)) groups.set(p.building, []);
    groups.get(p.building).push(p);
  }
  const order = [...r.utilization].sort((a, b) => b.pct - a.pct)
    .map((u) => u.building);
  let html = "";
  for (const b of [...order, ...groups.keys()].filter((v, i, a) => a.indexOf(v) === i)) {
    const ps = groups.get(b);
    if (!ps || !ps.length) continue;
    const u = r.utilization.find((x) => x.building === b);
    html += `<tr class="group"><td colspan="6">${b}（${u.count}座）　利用率 ` +
      `<b>${(u.pct * 100).toFixed(0)}%</b>${u.idle ? "　閒置" : ""}</td></tr>`;
    for (const p of ps) {
      let occupy;
      if (p.chain) {
        occupy = `累計${timeStr(p.batches * p.time_per_batch)} · 加工鏈`;
      } else if (p.flexible) {
        occupy = `累計${timeStr(p.batches * p.time_per_batch)} · 靈活換配方`;
      } else if (p.ttype === "生長" && !r.segments) {
        occupy = growPartsStr(
          growSplit(p.batches_int, Math.floor(r.hours * 3600 / p.time_per_batch)),
          p.time_per_batch);
      } else if (r.segments) {
        occupy = `峰值${fmt(p.slots)}${p.unit}`;
      } else {
        occupy = `累計${timeStr(p.batches_int * p.time_per_batch)}` +
          (r.lazy ? ` · 峰值${fmt(p.slots)}座` : "");
      }
      html += `<tr><td></td>` +
        `<td>${p.seasonal ? '<span class="star">★</span>' : ""}${p.label}</td>` +
        `<td class="ok">${fmt(p.batches_int)}</td>` +
        `<td>${fmt1(p.batches)}</td>` +
        `<td>${timeStr(p.time_per_batch)}</td>` +
        `<td>${occupy}</td></tr>`;
    }
  }
  tbody.innerHTML = html ||
    `<tr><td colspan="6" style="text-align:center;color:#64748B">無可用方案</td></tr>`;
}

function renderFlows(r) {
  const rows = Object.entries(r.flows)
    .map(([item, f]) => ({ item, ...f }))
    .sort((a, b) => b.value - a.value);
  $("#flow-table tbody").innerHTML = rows.map((f) => {
    const dests = (f.consumers || []).map((c) =>
      `<span class="dest">${c.label} <b>${fmt1(c.qty)}</b>` +
      `<i>${Math.round(c.pct * 100)}%</i></span>`).join("");
    const more = f.consumers_more > 0
      ? `<span class="dest">等 ${f.consumers_more} 項…</span>` : "";
    return `<tr><td>${f.item}</td><td>${fmt1(f.produced)}</td>` +
      `<td>${fmt1(f.consumed)}</td>` +
      `<td class="${f.surplus > 0.5 ? "ok" : ""}">${fmt1(f.surplus)}</td>` +
      `<td>${fmt(f.value)}</td>` +
      `<td>${fmt1(f.produced / r.hours)}</td>` +
      `<td>${fmt1(f.consumed / r.hours)}</td>` +
      `<td class="dests">${dests ? dests + more : "—"}</td></tr>`;
  }).join("");
}

function renderExcluded(r) {
  $("#excluded-list").innerHTML = r.excluded.length
    ? r.excluded.map((e) => `<span>${e.building}·${e.name}（${e.reason}）</span
