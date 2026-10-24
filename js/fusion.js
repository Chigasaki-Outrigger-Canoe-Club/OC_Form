// 複数方向の動画を合わせた「代表ストローク」の3Dモデル（推定値）
//
// 前提：3本の動画は同時撮影ではない。そのため同じ瞬間どうしの三角測量はできない。
// 代わりに次の手順で合わせる：
//   1. 各動画のストロークを 0〜100% に正規化し、漕ぐ側（左・右）ごとに平均する（代表ストローク）
//   2. 大きさをそろえる（胴の長さ＝肩の中点〜腰の中点 を全動画の平均に合わせる）
//   3. 同じ位相の点を、関節・軸ごとに「担当カメラ」を優先して合わせる（ROLES。4方向を平均しない）
//      重み＝役割（担当1・補助0.2・使わない0）× MediaPipe の信頼度。担当がよく見えていれば担当がほぼ決め、
//      担当の信頼度が低いときだけ補助が効く。関節ごとに、いちばん効いたカメラと信頼度を記録する
//      後ろの動画は肩の傾きで区切り（tilt.js）、肩の傾きが横の動画と重なるよう位相をずらしてから合わせる
//   4. 位相に沿って軽くならす（信頼度の低い点ほど、前後の位相に寄せる）
//   5. 漕ぎとしてありえない形を直す（constraints.js：骨の長さ・胴と頭の傾き）
//   6. 足をそろえる（legs.js の setFeet：かかと同士は拳1個分、内股にしない）
// 結果は「同じ漕ぎ方を繰り返している」と仮定した推定値で、特定の1ストロークの再現ではない。

import { P } from "./angles.js";
import { cameraDirection, median, shaftToBody } from "./body3d.js";
import { setFeet } from "./legs.js";
import { plausibleBody } from "./constraints.js";
import { gaussian, fillGaps } from "./smooth.js";
import { tiltCurve, bestShift, shiftPhases } from "./tilt.js";

export const PHASES = 101; // 0%, 1%, …, 100%
const AXES = ["x", "y", "z"];
const JOINT_COUNT = 33;

// 胴の長さ（肩の中点〜腰の中点）
function torso(f) {
  const s = { x: (f[P.lShoulder].x + f[P.rShoulder].x) / 2, y: (f[P.lShoulder].y + f[P.rShoulder].y) / 2, z: (f[P.lShoulder].z + f[P.rShoulder].z) / 2 };
  const h = { x: (f[P.lHip].x + f[P.rHip].x) / 2, y: (f[P.lHip].y + f[P.rHip].y) / 2, z: (f[P.lHip].z + f[P.rHip].z) / 2 };
  return Math.hypot(s.x - h.x, s.y - h.y, s.z - h.z);
}

// 位相（0〜100%）に沿って、点ごと・軸ごとにガウス重みでならす（σ＝PHASE_SIGMA %）
// sources があれば信頼度で重み付け：信頼度の低い点は、前後の位相（信頼度の高い点）に寄せる
const PHASE_SIGMA = 1.5;
export function smoothPhases(frames, sources = null) {
  const out = frames.map((f) => (f ? f.map((p) => ({ ...p })) : null));
  for (let j = 0; j < JOINT_COUNT; j++) {
    const weight = sources ? sources.map((s) => Math.max(s?.[j]?.score ?? 0, 0.05)) : [];
    for (const a of AXES) {
      gaussian(frames.map((f) => (f ? f[j][a] : null)), PHASE_SIGMA, weight).forEach((v, i) => out[i] && (out[i][j][a] = v));
    }
  }
  return out;
}

// 1つの関節を、各カメラの役割×信頼度（visibility）で合わせる
// list：[{ name, f: その位相の33点, k: 大きさの調整, joints: 役割の重み }]
// 戻り値：{ x, y, z, v, source: { main, share, score } }
//   score＝軸ごとの「役割×信頼度」の最大値の平均（担当カメラがよく見えていれば1に近い。補助だけなら低い）
function fuseJoint(list, j) {
  const point = { v: Math.max(...list.map((s) => s.f[j].v)) };
  const byView = Object.fromEntries(list.map((s) => [s.name, 0]));
  let score = 0;
  for (const a of AXES) {
    let sum = 0;
    let weight = 0;
    let best = 0;
    for (const s of list) {
      const role = s.joints[j][a];
      const w = role * Math.max(s.f[j].v, 0.01);
      sum += s.f[j][a] * s.k * w; // 大きさの調整は腰の中心（x・z＝0付近）と床（y＝0）を基準に掛ける
      weight += w;
      byView[s.name] += w;
      best = Math.max(best, role * s.f[j].v);
    }
    point[a] = sum / weight;
    score += Math.min(best, 1) / AXES.length;
  }
  const total = Object.values(byView).reduce((x, y) => x + y, 0);
  const [main, w] = Object.entries(byView).sort((x, y) => y[1] - x[1])[0];
  return { ...point, source: { main, share: w / total, score } };
}

// 肩の傾きで区切った動画（後ろなど）は、位相の0%が横の動画と違う。
// 漕ぐ側ごとに、肩の傾きの曲線が横（ほかの動画）と最もよく重なるようにずらす
//   基準は前の動画（肩の高さの差がよく見える）。前がなければ、ほかの手の高さで区切った動画
function alignTiltViews(entries) {
  const others = entries.filter(([, r]) => !r.alignByTilt);
  const refs = others.some(([name]) => name === "front") ? others.filter(([name]) => name === "front") : others;
  if (!refs.length) return entries;
  return entries.map(([name, r]) => {
    if (!r.alignByTilt) return [name, r];
    const out = { ...r, shaft: { ...r.shaft }, shift: {} };
    for (const side of ["right", "left"]) {
      const ref = averageCurve(refs.map(([, x]) => x[side]).filter(Boolean).map(tiltCurve));
      if (!r[side] || !ref) continue;
      const s = bestShift(tiltCurve(r[side]), ref);
      out[side] = shiftPhases(r[side], s);
      out.shaft[side] = shiftPhases(r.shaft?.[side], s);
      out.shift[side] = s;
    }
    return [name, out];
  });
}

// 曲線の位相ごとの平均（欠けは除く）。曲線がなければ null
function averageCurve(curves) {
  if (!curves.length) return null;
  return curves[0].map((_, i) => {
    const v = curves.map((c) => c[i]).filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  });
}

// 2フレームの間を直線で補間
function lerpFrame(a, b, t) {
  return a.map((p, i) => ({
    x: p.x + (b[i].x - p.x) * t, y: p.y + (b[i].y - p.y) * t, z: p.z + (b[i].z - p.z) * t, v: Math.min(p.v, b[i].v),
  }));
}

// ストロークの最後のフレーム。end は次のストロークの最初のフレームなので使わない
// （パドルチェンジのときは、次のストロークで上の手と下の手が入れ替わっているため）
const last = (start, end) => Math.max(start, end - 1);

// 1ストローク（start〜end−1 フレーム）を PHASES 点に並べ直す。欠けたフレームの位相は null
export function resampleStroke(body, start, end) {
  return Array.from({ length: PHASES }, (_, i) => {
    const pos = start + ((last(start, end) - start) * i) / (PHASES - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, last(start, end));
    if (!body[lo] || !body[hi]) return null;
    return lerpFrame(body[lo], body[hi], pos - lo);
  });
}

// 数値の配列の列（例：背中の膨らみ [30%,50%,70%]）を PHASES 点に並べ直す。欠けた位相は null
export function resampleSeries(series, start, end) {
  return Array.from({ length: PHASES }, (_, i) => {
    const pos = start + ((last(start, end) - start) * i) / (PHASES - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, last(start, end));
    const a = series[lo];
    const b = series[hi];
    if (!a || !b) return null;
    return a.map((v, k) => v + (b[k] - v) * (pos - lo));
  });
}

// 数値の配列の列を、位相ごとに平均する（欠けは除く）
export function averageSeries(list) {
  return Array.from({ length: PHASES }, (_, i) => {
    const values = list.map((s) => s[i]).filter(Boolean);
    if (!values.length) return null;
    return values[0].map((_, k) => values.reduce((sum, v) => sum + v[k], 0) / values.length);
  });
}

// 複数ストロークを位相ごとに平均する
export function averageStrokes(strokes) {
  return Array.from({ length: PHASES }, (_, i) => {
    const frames = strokes.map((s) => s[i]).filter(Boolean);
    if (!frames.length) return null;
    return Array.from({ length: JOINT_COUNT }, (_, j) => {
      const pts = frames.map((f) => f[j]);
      const mean = (k) => pts.reduce((sum, p) => sum + p[k], 0) / pts.length;
      return { x: mean("x"), y: mean("y"), z: mean("z"), v: mean("v") };
    });
  });
}

// ---- 関節ごとの担当カメラ（4方向を平均しない。担当を優先し、ほかは補助） ----
// 部位：顔、肩、肘、手（手首・指）、腰、脚（膝から下）。MediaPipe の番号で、奇数＝左半身・偶数＝右半身
const PART_OF = (j) => (j <= 10 ? "head" : j <= 12 ? "shoulder" : j <= 14 ? "elbow" : j <= 22 ? "hand" : j <= 24 ? "hip" : "leg");
const isLeft = (j) => (j <= 10 ? [1, 2, 3, 7, 9].includes(j) : j % 2 === 1);
// 役割：[X＝左右, Y＝上下, Z＝前後] ごとに、1＝担当、AUX＝補助、0＝使わない
//   手首・肘・脚：横が担当、前・後ろは補助（担当の信頼度が低いときに効く）
//   肩：前・後ろが担当（左右の位置・高さの差＝体幹の左右の傾き）、横は補助
//   骨盤：後ろが担当（高さの差）、横は補助
//   体幹の前傾（肩・腰の前後＝Z）：横だけ。前・後ろの Z はカメラの奥行きで大きくずれるため、どの部位でも使わない
const AUX = 0.2;
export const ROLES = {
  side: { head: [1, 1, 1], shoulder: [AUX, AUX, 1], elbow: [1, 1, 1], hand: [1, 1, 1], hip: [AUX, AUX, 1], leg: [1, 1, 1] },
  front: { head: [AUX, AUX, 0], shoulder: [1, 1, 0], elbow: [AUX, AUX, 0], hand: [AUX, AUX, 0], hip: [0, 0, 0], leg: [0, 0, 0] },
  back: { head: [AUX, AUX, 0], shoulder: [1, 1, 0], elbow: [AUX, AUX, 0], hand: [AUX, AUX, 0], hip: [1, 1, 0], leg: [0, 0, 0] },
};
// 横の動画で、カメラと反対側の半身（体に隠れやすい）に掛ける割合
export const FAR = { head: 1, shoulder: 0.6, elbow: 0.5, hand: 0.5, hip: 0.7, leg: 0.6 };
const UNUSED = 0.001; // 使わない軸もごくわずかに残す（その軸を撮った動画がほかにないときのため）

// 方向の種類：名前（left・right・front・back）から。名前がなければカメラの方向から
export function viewKind(name, cam) {
  if (name === "left" || name === "right") return "side";
  if (name === "front" || name === "back") return name;
  return Math.abs(cam.z) >= Math.abs(cam.x) ? (cam.z > 0 ? "front" : "back") : "side";
}

// 33点それぞれの、軸ごとの役割の重み [{ x, y, z }]。nearLeft＝カメラが選手の左側（横の動画のとき）
export function jointWeights(kind, nearLeft) {
  return Array.from({ length: JOINT_COUNT }, (_, j) => {
    const part = PART_OF(j);
    const far = kind === "side" && isLeft(j) !== nearLeft ? FAR[part] : 1;
    const [x, y, z] = ROLES[kind][part].map((r) => Math.max(r * far, UNUSED));
    return { x, y, z };
  });
}

// ---- 画像から見つけたシャフトの向き（前・後ろの動画） ----
// 1ストロークのシャフトの向きを PHASES 点に（その位相に最も近いフレームの値。なければ null）
function resampleShaft(dirs, start, end) {
  return Array.from({ length: PHASES }, (_, i) => dirs[Math.round(start + ((last(start, end) - start) * i) / (PHASES - 1))] ?? null);
}

// 位相ごとに向きを平均する（確かさで重み付け）。list：[[{x,y,z,s}|null × PHASES], …]
// 戻り値：[{ x, y, z, s } | null]（s＝重みの合計。見つからない位相は前後から補間して、軽くならす）
export function averageShaft(list) {
  const sum = Array.from({ length: PHASES }, (_, i) => {
    const found = list.map((s) => s[i]).filter(Boolean);
    if (!found.length) return null;
    const v = ["x", "y", "z"].map((a) => found.reduce((t, d) => t + d[a] * d.s, 0));
    return { v, s: found.reduce((t, d) => t + d.s, 0) };
  });
  if (!sum.some(Boolean)) return null;
  const axis = (k) => gaussian(fillGaps(sum.map((x) => (x ? x.v[k] / x.s : null)), 15, sum.map(() => null)), PHASE_SIGMA);
  const [xs, ys, zs] = [0, 1, 2].map(axis);
  const ss = fillGaps(sum.map((x) => x?.s ?? null), 15, sum.map(() => null));
  return xs.map((x, i) => {
    if (x == null) return null;
    const len = Math.hypot(x, ys[i], zs[i]) || 1;
    return { x: x / len, y: ys[i] / len, z: zs[i] / len, s: ss[i] };
  });
}

// 1方向分の代表ストローク { right, left, spine, counts, kind, joints, sideWeight, torso }
// view：{ name, body, world, strokes, spine }（name＝left・right・front・back、spine＝フレームごとの背中の膨らみ。なければ省略可）
export function viewRepresentative(view) {
  const groups = { right: [], left: [] };
  const spines = { right: [], left: [] };
  const shafts = { right: [], left: [] };
  const shaftDirs = shaftToBody(view.world, view.shaft);
  view.strokes.forEach((s, n) => {
    const next = view.strokes[n + 1];
    if (!next || !groups[s.side]) return;
    groups[s.side].push(resampleStroke(view.body, s.frame, next.frame));
    if (view.spine) spines[s.side].push(resampleSeries(view.spine, s.frame, next.frame));
    if (shaftDirs) shafts[s.side].push(resampleShaft(shaftDirs, s.frame, next.frame));
  });

  const cam = cameraDirection(view.world);
  const kind = viewKind(view.name, cam);
  const nearLeft = view.name ? view.name === "left" : cam.x > 0;
  return {
    right: groups.right.length ? averageStrokes(groups.right) : null,
    left: groups.left.length ? averageStrokes(groups.left) : null,
    spine: { right: spines.right.length ? averageSeries(spines.right) : null, left: spines.left.length ? averageSeries(spines.left) : null },
    counts: { right: groups.right.length, left: groups.left.length },
    shaft: { right: shafts.right.length ? averageShaft(shafts.right) : null, left: shafts.left.length ? averageShaft(shafts.left) : null },
    kind,
    joints: jointWeights(kind, nearLeft),
    alignByTilt: view.strokes.some((st) => st.src === "tilt"), // 肩の傾きで区切ったストローク（位相を横の動画に合わせる）
    // 背中の輪郭は横から撮ったときだけ意味がある。横向きの度合い＝カメラ方向の左右成分の2乗
    sideWeight: cam.x ** 2,
    camera: cam,
    torso: median(view.body.filter(Boolean).map(torso)),
  };
}

// 方向ごとの代表ストロークを1つにまとめる
// reps：{ left: viewRepresentative(...), back: ... }
// 戻り値：{ right: { frames, views, strokes }, left: {...} }（その側のデータがなければ null）
export function fuseViews(reps) {
  const entries = alignTiltViews(Object.entries(reps));
  const torsos = entries.map(([, r]) => r.torso).filter((t) => t > 0);
  const targetTorso = torsos.reduce((a, b) => a + b, 0) / (torsos.length || 1);

  const fuseSide = (side) => {
    const used = entries.filter(([, r]) => r[side]);
    if (!used.length) return null;
    // 位相ごと・関節ごと・軸ごとに、担当カメラを優先して合わせる。使ったカメラと信頼度も残す
    const sources = [];
    const frames = Array.from({ length: PHASES }, (_, i) => {
      const list = used.map(([name, r]) => ({ name, f: r[side][i], k: targetTorso / r.torso, joints: r.joints })).filter((s) => s.f);
      sources.push(null);
      if (!list.length) return null;
      const out = Array.from({ length: JOINT_COUNT }, (_, j) => fuseJoint(list, j));
      sources[i] = out.map((p) => p.source);
      return out.map(({ source, ...p }) => p);
    });
    // 背中の膨らみ：横から撮った動画を重く使って平均（横からの動画がなければ null）
    const spine = Array.from({ length: PHASES }, (_, i) => {
      const src = used.map(([, r]) => ({ v: r.spine?.[side]?.[i], w: r.sideWeight })).filter((x) => x.v && x.w > 0.3);
      const total = src.reduce((sum, x) => sum + x.w, 0);
      return total ? [0, 1, 2].map((k) => src.reduce((sum, x) => sum + x.v[k] * x.w, 0) / total) : null;
    });
    // シャフトの向き：前・後ろの動画で見つけたものを、確かさで重み付けして平均（なければ null）
    const shaftList = used.map(([, r]) => r.shaft?.[side]).filter(Boolean);
    const shaft = shaftList.length ? Array.from({ length: PHASES }, (_, i) => {
      const found = shaftList.map((l) => l[i]).filter(Boolean);
      if (!found.length) return null;
      const v = ["x", "y", "z"].map((a) => found.reduce((t, d) => t + d[a] * d.s, 0));
      const len = Math.hypot(...v) || 1;
      return { x: v[0] / len, y: v[1] / len, z: v[2] / len };
    }) : null;
    return {
      frames: setFeet(plausibleBody(smoothPhases(frames, sources))),
      sources, // [位相][関節] = { main: いちばん効いたカメラ, share: その割合, score: 信頼度 0〜1 }
      shaft,
      spine: spine.some(Boolean) ? spine : null,
      views: used.map(([name]) => name),
      strokes: Object.fromEntries(used.map(([name, r]) => [name, r.counts[side]])),
    };
  };

  return { right: fuseSide("right"), left: fuseSide("left") };
}

// フレーム番号 → そのストロークの位相（0〜PHASES-1）と漕ぐ側。ストローク外は null
export function phaseAt(frame, strokes) {
  for (let n = 0; n < strokes.length - 1; n++) {
    const start = strokes[n].frame;
    const end = strokes[n + 1].frame;
    if (frame >= start && frame < end) {
      return { index: Math.round(((frame - start) / (end - start)) * (PHASES - 1)), side: strokes[n].side };
    }
  }
  return null;
}

// 漕ぐ側ごとの1ストロークの平均時間（秒）。3Dの代表ストロークを繰り返し再生する速さに使う
// views：[{ fps, strokes }]
export function sideDurations(views) {
  const secs = { right: [], left: [] };
  for (const v of views) {
    v.strokes.forEach((s, n) => {
      const next = v.strokes[n + 1];
      if (next && secs[s.side]) secs[s.side].push((next.frame - s.frame) / v.fps);
    });
  }
  const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
  return { right: avg(secs.right), left: avg(secs.left) };
}

// 部位ごとに、いちばん効いたカメラと信頼度の平均（画面に出す要約）
// f：fuseViews の右・左の結果 → [{ part, main, score }]（記録がなければ空）
const SUMMARY = { 肩: [11, 12], 肘: [13, 14], 手首: [15, 16], 腰: [23, 24], 膝: [25, 26] };
export function sourceSummary(f) {
  if (!f?.sources) return [];
  return Object.entries(SUMMARY).map(([part, joints]) => {
    const list = f.sources.filter(Boolean).flatMap((s) => joints.map((j) => s[j]));
    const count = {};
    list.forEach((s) => (count[s.main] = (count[s.main] ?? 0) + 1));
    const main = Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
    return { part, main, score: list.reduce((t, s) => t + s.score, 0) / list.length };
  });
}
