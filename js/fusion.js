// 複数方向の動画を合わせた「代表ストローク」の3Dモデル（推定値）
//
// 前提：3本の動画は同時撮影ではない。そのため同じ瞬間どうしの三角測量はできない。
// 代わりに次の手順で合わせる：
//   1. 各動画のストロークを 0〜100% に正規化し、漕ぐ側（左・右）ごとに平均する（代表ストローク）
//   2. 大きさをそろえる（胴の長さ＝肩の中点〜腰の中点 を全動画の平均に合わせる）
//   3. 同じ位相の点を方向ごとに重み付き平均する
//      重み＝MediaPipeの信頼度 ×「軸ごとの見やすさ」
//      見やすさ：カメラの奥行き方向の軸は低く（1台のカメラでは奥行きの精度が低いため）、
//      画面に平行な軸は高くする。 reliability(軸) = 1 − 0.8 ×（カメラ方向の成分）²
// 結果は「同じ漕ぎ方を繰り返している」と仮定した推定値で、特定の1ストロークの再現ではない。

import { P } from "./angles.js";
import { cameraDirection, median } from "./body3d.js";

export const PHASES = 101; // 0%, 1%, …, 100%
const DEPTH_PENALTY = 0.8;
const AXES = ["x", "y", "z"];
const JOINT_COUNT = 33;

// 胴の長さ（肩の中点〜腰の中点）
function torso(f) {
  const s = { x: (f[P.lShoulder].x + f[P.rShoulder].x) / 2, y: (f[P.lShoulder].y + f[P.rShoulder].y) / 2, z: (f[P.lShoulder].z + f[P.rShoulder].z) / 2 };
  const h = { x: (f[P.lHip].x + f[P.rHip].x) / 2, y: (f[P.lHip].y + f[P.rHip].y) / 2, z: (f[P.lHip].z + f[P.rHip].z) / 2 };
  return Math.hypot(s.x - h.x, s.y - h.y, s.z - h.z);
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

// 1方向分の代表ストローク { right, left, spine, counts, reliability, sideWeight, torso }
// view：{ body, world, strokes, spine }（spine＝フレームごとの背中の膨らみ。なければ省略可）
export function viewRepresentative(view) {
  const groups = { right: [], left: [] };
  const spines = { right: [], left: [] };
  view.strokes.forEach((s, n) => {
    const next = view.strokes[n + 1];
    if (!next || !groups[s.side]) return;
    groups[s.side].push(resampleStroke(view.body, s.frame, next.frame));
    if (view.spine) spines[s.side].push(resampleSeries(view.spine, s.frame, next.frame));
  });

  const cam = cameraDirection(view.world);
  const reliability = Object.fromEntries(AXES.map((a) => [a, 1 - DEPTH_PENALTY * cam[a] ** 2]));
  return {
    right: groups.right.length ? averageStrokes(groups.right) : null,
    left: groups.left.length ? averageStrokes(groups.left) : null,
    spine: { right: spines.right.length ? averageSeries(spines.right) : null, left: spines.left.length ? averageSeries(spines.left) : null },
    counts: { right: groups.right.length, left: groups.left.length },
    reliability,
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
  const entries = Object.entries(reps);
  const torsos = entries.map(([, r]) => r.torso).filter((t) => t > 0);
  const targetTorso = torsos.reduce((a, b) => a + b, 0) / (torsos.length || 1);

  const fuseSide = (side) => {
    const used = entries.filter(([, r]) => r[side]);
    if (!used.length) return null;
    const frames = Array.from({ length: PHASES }, (_, i) => {
      const sources = used.map(([, r]) => ({ f: r[side][i], k: targetTorso / r.torso, rel: r.reliability })).filter((s) => s.f);
      if (!sources.length) return null;
      return Array.from({ length: JOINT_COUNT }, (_, j) => {
        const point = { v: Math.max(...sources.map((s) => s.f[j].v)) };
        for (const a of AXES) {
          let sum = 0;
          let weight = 0;
          for (const s of sources) {
            const w = Math.max(s.f[j].v, 0.01) * s.rel[a];
            // 大きさの調整は腰の中心（x・z＝0付近）と床（y＝0）を基準に掛ける
            sum += s.f[j][a] * s.k * w;
            weight += w;
          }
          point[a] = sum / weight;
        }
        return point;
      });
    });
    // 背中の膨らみ：横から撮った動画を重く使って平均（横からの動画がなければ null）
    const spine = Array.from({ length: PHASES }, (_, i) => {
      const src = used.map(([, r]) => ({ v: r.spine?.[side]?.[i], w: r.sideWeight })).filter((x) => x.v && x.w > 0.3);
      const total = src.reduce((sum, x) => sum + x.w, 0);
      return total ? [0, 1, 2].map((k) => src.reduce((sum, x) => sum + x.v[k] * x.w, 0) / total) : null;
    });
    return {
      frames,
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
