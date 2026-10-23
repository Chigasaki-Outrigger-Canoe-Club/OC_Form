// Concept2（PM5）のストロークデータ（CSV）を読み、まとめと改善点を出す
// 対応：Concept2 Logbook のストロークデータ書き出し、ほかのアプリ（ErgData・RowsAndAll など）の CSV
//   列は見出しの言葉から判定する（例："Watts"→ワット、"Stroke Rate"→ピッチ）。知らない列は無視する
//   力の波形（フォースカーブ）は、1つのセルに数字が並んだ列があれば読む（Logbook の CSV には入っていない）
// 改善点の目安（LIMITS）は、このサイトの仮の基準（裏付けのある数値ではない）

import { rateNote } from "./feedback.js";

// 列の種類：[キー, 見出しに含まれる言葉, 表示名]。上から順に判定する（"drive time" を "time" より先に）
const COLUMNS = [
  ["curve", /curve|force ?plot|波形/, "力の波形"],
  ["peakForce", /peak.*force|最大.*力/, "最大の力"],
  ["avgForce", /av(era)?g.*force|平均.*力/, "平均の力"],
  ["driveLength", /drive ?length|ストローク長/, "引きの長さ"],
  ["driveTime", /drive ?time/, "引きの時間"],
  ["recoveryTime", /recovery/, "戻しの時間"],
  ["watts", /watt|power|ワット/, "ワット"],
  ["spm", /stroke ?rate|cadence|spm|ピッチ/, "ピッチ"],
  ["hr", /heart|^hr|hrcur|心拍|bpm/, "心拍"],
  ["pace", /pace|ペース/, "ペース"],
  ["distance", /dist|horizontal|距離|meters\)?$/, "距離"],
  ["time", /time|elapsed|経過|時間/, "時間"],
];

export const LIMITS = {
  wattsCv: 10,   // ワットのばらつき（%）がこれより大きい → ムラ
  fade: 8,       // 前半→後半のワットの落ち（%）
  hrDrift: 5,    // 同じワットあたりの心拍の上がり（%）→ 疲れのサイン
  rateWork: -0.5, // ピッチと1本の仕事の相関がこれより低い → ピッチを上げると1本が軽くなる
  warmup: 10,    // 最初の何秒を「漕ぎ出し」として除くか
};

// ---- CSV ----
function splitLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { cells.push(cell.trim()); cell = ""; }
    else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

// "1:52.3" → 112.3 秒、"95.2" → 95.2
export function toSeconds(text) {
  if (text == null || text === "") return null;
  const parts = String(text).split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((sum, n) => sum * 60 + n, 0);
}

const toNumber = (text) => (text === "" || text == null || Number.isNaN(Number(text)) ? null : Number(text));
const toCurve = (text) => {
  const list = String(text).split(/[\s;|]+/).filter(Boolean).map(Number);
  return list.length >= 3 && !list.some(Number.isNaN) ? list : null;
};

// 見出しの行から列の種類を決める。戻り値：{ キー: 列番号 }、units：{ キー: 見出しの文字 }
function matchColumns(header) {
  const index = {};
  const units = {};
  header.forEach((name, i) => {
    const text = name.toLowerCase();
    const found = COLUMNS.find(([key, re]) => !(key in index) && re.test(text));
    if (found) { index[found[0]] = i; units[found[0]] = name; }
  });
  return { index, units };
}

// 戻り値：{ strokes: [{ time, watts, spm, hr, pace, ... , curve }], columns: [表示名], units }
//   読めないとき：{ error: "理由" }
export function parseErgCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  // 見出しの行：知っている列が2つ以上ある最初の行
  const headerAt = lines.findIndex((l) => Object.keys(matchColumns(splitLine(l)).index).length >= 2);
  if (headerAt < 0) return { error: "列の見出し（Time・Watts・Stroke Rate など）が見つかりません" };
  const { index, units } = matchColumns(splitLine(lines[headerAt]));

  const strokes = [];
  for (const line of lines.slice(headerAt + 1)) {
    const cells = splitLine(line);
    const s = {};
    for (const [key, i] of Object.entries(index)) {
      const cell = cells[i];
      s[key] = key === "curve" ? toCurve(cell) : key === "time" || key === "pace" ? toSeconds(cell) : toNumber(cell);
    }
    if (Object.values(s).some((v) => v != null)) strokes.push(s);
  }
  // 時間の列がなければ、ピッチから時間を作る
  if (!("time" in index) && "spm" in index) {
    let t = 0;
    for (const s of strokes) { s.time = t; t += s.spm ? 60 / s.spm : 0; }
  }
  // ペースの列がなく、ワットがあれば計算する（Concept2の式：ワット = 2.80 / (ペース/500)^3）
  if (!("pace" in index) && "watts" in index) {
    for (const s of strokes) s.pace = s.watts > 0 ? 500 * Math.cbrt(2.8 / s.watts) : null;
  }
  if (!strokes.length) return { error: "データの行がありません" };
  const columns = COLUMNS.filter(([key]) => key in index).map(([, , label]) => label);
  return { strokes, columns, units };
}

// ---- 計算 ----
const values = (list, key) => list.map((s) => s[key]).filter((v) => v != null && v > 0);
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const thirds = (list) => [list.slice(0, Math.floor(list.length / 3)), list.slice(Math.ceil((list.length * 2) / 3))];

function correlation(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// 波形を n 点にそろえる（引きの始め＝0%、終わり＝100%）
export function resample(curve, n = 50) {
  return Array.from({ length: n }, (_, i) => {
    const pos = (i / (n - 1)) * (curve.length - 1);
    const a = Math.floor(pos);
    const b = Math.min(curve.length - 1, a + 1);
    return curve[a] + (curve[b] - curve[a]) * (pos - a);
  });
}

// 平均の波形：最大の位置（引きの何%）と、途中の「へこみ」の数（最大の10%以上下がって、また10%以上上がる）
function curveShape(curves) {
  const list = curves.map((c) => resample(c));
  const avg = list[0].map((_, i) => mean(list.map((c) => c[i])));
  const peak = Math.max(...avg);
  let top = avg[0];
  let low = avg[0];
  let dips = 0;
  for (const v of avg) {
    if (top - low > peak * 0.1 && v - low > peak * 0.1) { dips++; top = v; low = v; }
    else if (v > top) { top = v; low = v; }
    else low = Math.min(low, v);
  }
  return { avg, peakAt: avg.indexOf(peak) / (avg.length - 1), dips };
}

// 戻り値：{ summary, rows }。rows の各行：{ label, value, flagged, comment, note }
export function analyzeErg(strokes) {
  const start = strokes[0]?.time ?? 0;
  const steady = strokes.filter((s) => s.time == null || s.time - start >= LIMITS.warmup);
  const use = steady.length >= 10 ? steady : strokes;
  const last = strokes[strokes.length - 1];
  const watts = values(use, "watts");
  const spm = values(use, "spm");
  const hr = values(use, "hr");

  const summary = {
    strokes: strokes.length,
    time: last?.time != null ? last.time - start : null,
    distance: last?.distance ?? null,
    watts: mean(watts),
    spm: mean(spm),
    hr: mean(hr),
    pace: mean(values(use, "pace")),
  };

  const rows = [];
  if (watts.length >= 6) {
    const sd = Math.sqrt(mean(watts.map((w) => (w - summary.watts) ** 2)));
    const cv = (sd / summary.watts) * 100;
    rows.push({
      label: "力のムラ（ワットのばらつき）", value: `${cv.toFixed(1)}%`, flagged: cv > LIMITS.wattsCv,
      comment: "1本ごとのワットの差が大きめです。同じ力で引き続けられているか、強く引けた本と弱い本の違い（キャッチの深さ・抜きの位置）を動画で見比べてください。",
    });
    const [first, end] = thirds(watts);
    const fade = (1 - mean(end) / mean(first)) * 100;
    rows.push({
      label: "後半の落ち（前半1/3→後半1/3のワット）", value: `${fade >= 0 ? "-" : "+"}${Math.abs(fade).toFixed(1)}%`, flagged: fade > LIMITS.fade,
      comment: "後半にワットが落ちています。前半を抑えて均等に配分するか、後半に崩れる動き（体幹の前傾が浅くなる等）がないか確認してください。",
    });
  }
  if (spm.length >= 6) {
    rows.push({ label: "ピッチ", value: `${summary.spm.toFixed(1)} spm`, flagged: false, note: rateNote(summary.spm) });
    const pairs = use.filter((s) => s.watts > 0 && s.spm > 0);
    const r = correlation(pairs.map((s) => s.spm), pairs.map((s) => (s.watts * 60) / s.spm)); // 1本の仕事（J）
    if (r != null) rows.push({
      label: "ピッチと1本の力の関係", value: `相関 ${r.toFixed(2)}`, flagged: r < LIMITS.rateWork,
      comment: "ピッチが上がると1本あたりの仕事（ワット×60÷ピッチ）が小さくなっています。ピッチを上げたときに引きが短く・浅くなっていないか確認してください。",
      note: "1に近い＝ピッチを上げても1本の力が保てている、−1に近い＝ピッチを上げると1本が軽くなる。",
    });
  }
  if (hr.length >= 6 && watts.length >= 6) {
    const pairs = use.filter((s) => s.watts > 0 && s.hr > 0);
    const [first, end] = thirds(pairs);
    const perWatt = (list) => mean(list.map((s) => s.hr)) / mean(list.map((s) => s.watts));
    const drift = (perWatt(end) / perWatt(first) - 1) * 100;
    rows.push({
      label: "疲れのサイン（同じワットあたりの心拍）", value: `${drift >= 0 ? "+" : ""}${drift.toFixed(1)}%`, flagged: drift > LIMITS.hrDrift,
      comment: "後半は同じワットを出すのに心拍が高くなっています（心拍のずれ＝疲れのサイン）。長い練習では水分補給やペース配分を見直してください。",
      note: "心拍は力に遅れて上がるので、3分以上の一定ペースの漕ぎで見るのがおすすめです。",
    });
  }
  const curves = strokes.map((s) => s.curve).filter(Boolean);
  let shape = null;
  if (curves.length) {
    shape = curveShape(curves);
    rows.push({
      label: "力の波形（平均）", value: `最大は引きの${Math.round(shape.peakAt * 100)}%`, flagged: shape.dips > 0,
      comment: "波形の山の途中にへこみがあります。キャッチで掛けた力が途中で抜けている（脚・体幹・腕のつなぎが途切れている）可能性があります。",
      note: "なめらかな山が1つの形が目安です。最大が前寄り＝キャッチで早く力が掛かっている、後ろ寄り＝引きの後半で力を出しています。",
    });
  }
  return { summary, rows, curve: shape?.avg ?? null };
}
