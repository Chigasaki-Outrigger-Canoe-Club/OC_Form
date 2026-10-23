// Concept2 の画面：CSVを読み込み、まとめ・グラフ・改善点を表示する
import { parseErgCsv, analyzeErg, resample } from "./erg.js";

const el = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const clock = (sec) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, "0")}`;
const whole = (v) => v.toFixed(0);

// 時間に沿ったグラフ（列があるものだけ表示）
const CHARTS = [
  { key: "watts", label: "ワット", unit: "W", format: whole },
  { key: "pace", label: "ペース（/500m。上ほど速い）", unit: "", format: clock, invert: true },
  { key: "spm", label: "ピッチ", unit: "spm", format: whole },
  { key: "hr", label: "心拍", unit: "bpm", format: whole },
  { key: "peakForce", label: "最大の力", unit: "", format: whole },
  { key: "driveLength", label: "引きの長さ", unit: "m", format: (v) => v.toFixed(2) },
];

// 折れ線グラフ。series：[{ ys, color, width }]（ys の長さは xs と同じ、値なしは null）
// 戻り値：hover(i) … i 番目の位置に縦線と点を描く（null で消す）
function drawChart(canvas, { xs, series, invert = false, formatY }) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  const pad = { left: 48, right: 8, top: 8, bottom: 8 };
  const all = series.flatMap((s) => s.ys).filter((v) => v != null);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi === lo) { hi += 1; lo -= 1; }
  const x0 = xs[0];
  const x1 = xs[xs.length - 1] === x0 ? x0 + 1 : xs[xs.length - 1];
  const px = (x) => pad.left + ((x - x0) / (x1 - x0)) * (w - pad.left - pad.right);
  const py = (y) => {
    const t = (y - lo) / (hi - lo);
    return pad.top + (invert ? t : 1 - t) * (h - pad.top - pad.bottom);
  };

  const draw = (hoverIndex) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // 目盛り（3本）
    ctx.font = "11px system-ui";
    ctx.textBaseline = "middle";
    for (const t of [0, 0.5, 1]) {
      const v = lo + (hi - lo) * t;
      ctx.strokeStyle = css("--border");
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, py(v)); ctx.lineTo(w - pad.right, py(v)); ctx.stroke();
      ctx.fillStyle = css("--muted");
      ctx.fillText(formatY(v), 4, py(v));
    }
    // 線
    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineJoin = "round";
      ctx.beginPath();
      let pen = false;
      s.ys.forEach((y, i) => {
        if (y == null) { pen = false; return; }
        if (pen) ctx.lineTo(px(xs[i]), py(y)); else ctx.moveTo(px(xs[i]), py(y));
        pen = true;
      });
      ctx.stroke();
    }
    // なぞった位置
    const main = series[series.length - 1];
    if (hoverIndex != null && main.ys[hoverIndex] != null) {
      const x = px(xs[hoverIndex]);
      ctx.strokeStyle = css("--muted");
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, h - pad.bottom); ctx.stroke();
      ctx.fillStyle = main.color;
      ctx.strokeStyle = css("--panel");
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, py(main.ys[hoverIndex]), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  };
  draw(null);
  // 画面のx座標 → いちばん近いデータの番号
  const indexAt = (clientX) => {
    const x = x0 + ((clientX - canvas.getBoundingClientRect().left - pad.left) / (w - pad.left - pad.right)) * (x1 - x0);
    let best = 0;
    xs.forEach((v, i) => { if (Math.abs(v - x) < Math.abs(xs[best] - x)) best = i; });
    return best;
  };
  return { draw, indexAt };
}

// グラフ1つ分の枠（見出し・キャンバス・なぞった値）を作る
function addChart(parent, title, options, readout) {
  const box = Object.assign(document.createElement("div"), { className: "erg-chart" });
  box.innerHTML = `<p class="erg-title">${title}</p><canvas></canvas><p class="muted small erg-readout">グラフをなぞると値が出ます</p>`;
  parent.appendChild(box);
  const canvas = box.querySelector("canvas");
  const text = box.querySelector(".erg-readout");
  const render = () => {
    const chart = drawChart(canvas, options);
    canvas.onpointermove = (e) => { const i = chart.indexAt(e.clientX); chart.draw(i); text.textContent = readout(i); };
    canvas.onpointerleave = () => chart.draw(null);
  };
  render();
  return render;
}

// 移動平均（前後 n 本）。値なしは飛ばす
function smooth(ys, n = 5) {
  return ys.map((y, i) => {
    const near = ys.slice(Math.max(0, i - n), i + n + 1).filter((v) => v != null);
    return y == null || !near.length ? null : near.reduce((a, b) => a + b, 0) / near.length;
  });
}

let redraws = []; // 画面の幅が変わったときに描き直す

function show(name, text) {
  const parsed = parseErgCsv(text);
  const charts = el("ergCharts");
  charts.innerHTML = "";
  el("ergFeedback").innerHTML = "";
  el("ergResult").hidden = Boolean(parsed.error);
  if (parsed.error) { el("ergInfo").textContent = `${name}：読めませんでした（${parsed.error}）`; return; }

  const { strokes, columns } = parsed;
  const { summary, rows } = analyzeErg(strokes);
  el("ergInfo").textContent = `${name}：${strokes.length}ストローク。読めた列：${columns.join("・")}`
    + (columns.includes("力の波形") ? "" : "。力の波形はこのファイルにありません");

  const items = [
    ["時間", summary.time != null && clock(summary.time)],
    ["距離", summary.distance != null && `${whole(summary.distance)} m`],
    ["平均ペース", summary.pace && `${clock(summary.pace)} /500m`],
    ["平均ワット", summary.watts && `${whole(summary.watts)} W`],
    ["平均ピッチ", summary.spm && `${summary.spm.toFixed(1)} spm`],
    ["平均心拍", summary.hr && `${whole(summary.hr)} bpm`],
  ].filter(([, v]) => v);
  el("ergSummary").innerHTML = items.map(([k, v]) => `<div class="erg-stat"><span class="muted small">${k}</span><b>${v}</b></div>`).join("");

  const xs = strokes.map((s) => s.time ?? 0);
  const accent = css("--accent");
  // 細い線＝1本ごと、太い線＝前後5本の移動平均
  redraws = CHARTS.filter((c) => strokes.some((s) => s[c.key] != null)).map((c) => {
    const ys = strokes.map((s) => s[c.key]);
    const avg = smooth(ys);
    return addChart(charts, c.label,
      { xs, series: [{ ys, color: css("--border"), width: 1 }, { ys: avg, color: accent, width: 2 }], invert: c.invert, formatY: c.format },
      (i) => `${clock(xs[i])}　${c.format(ys[i] ?? 0)} ${c.unit}（前後5本の平均 ${c.format(avg[i] ?? 0)}）`);
  });

  // 力の波形：各ストローク（細い線）と平均（太い線）。横軸＝引きの始め0%〜終わり100%
  const curves = strokes.map((s) => s.curve).filter(Boolean).map((c) => resample(c));
  if (curves.length) {
    const avg = curves[0].map((_, i) => curves.reduce((sum, c) => sum + c[i], 0) / curves.length);
    const pct = avg.map((_, i) => (i / (avg.length - 1)) * 100);
    const thin = curves.slice(-150).map((ys) => ({ ys, color: css("--border"), width: 1 }));
    redraws.push(addChart(charts, "力の波形（細い線＝各ストローク、太い線＝平均）",
      { xs: pct, series: [...thin, { ys: avg, color: accent, width: 3 }], formatY: whole },
      (i) => `引きの${pct[i].toFixed(0)}%　平均 ${whole(avg[i])}`));
  }

  for (const row of rows) {
    const parts = [];
    parts.push(row.flagged ? `<span class="flag">改善候補</span><br>${row.comment}` : row.comment ? '<span class="muted">目安の範囲内</span>' : "");
    if (row.note) parts.push(`<span class="muted">${row.note}</span>`);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.label}</td><td>${row.value}</td><td>${parts.filter(Boolean).join("<br>")}</td>`;
    el("ergFeedback").appendChild(tr);
  }
}

export function setupErg() {
  el("ergFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) show(file.name, await file.text());
  });
  new ResizeObserver(() => redraws.forEach((r) => r())).observe(el("ergCharts"));
}
