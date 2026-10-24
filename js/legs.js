// 脚の安定化（3D、選手基準の座標）
//
// エルゴでは足はフットストレッチャーに固定されていて、足首はほとんど動かない。
// ところが手が足首と重なる場面では、MediaPipe が足首・膝を大きく見誤ることがある。
// そこで次の2つの仮定を置いて補正する（補正した点は推定値のまま）：
//   1. 足首・かかと・つま先は動かない → 全フレームの中央値に固定
//      （動画の最初の準備で動いても、中央値なので影響は小さい）
//   2. 大腿（股関節〜膝）と下腿（膝〜足首）の長さは変わらない
//      → 膝は「股関節と足首から決まる円」の上にある。推定した膝に最も近い円上の点を使う
//   その後、膝を前後2フレームで平均し、もう一度円の上に戻す（細かい揺れを抑える）
// 全方向を合わせたモデルには、さらに足の置き方（setFeet）を当てはめる

import { P } from "./angles.js";

const FOOT = { left: [P.lAnkle, 29, 31], right: [P.rAnkle, 30, 32] }; // 足首・かかと・つま先
const LEG = { left: { hip: P.lHip, knee: P.lKnee, ankle: P.lAnkle }, right: { hip: P.rHip, knee: P.rKnee, ankle: P.rAnkle } };

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.hypot(a.x, a.y, a.z);

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

const medianPoint = (pts) => ({ x: median(pts.map((p) => p.x)), y: median(pts.map((p) => p.y)), z: median(pts.map((p) => p.z)) });

// 股関節 hip・足首 ankle から、大腿 thigh・下腿 shin の長さを保つ膝の位置（guess に最も近い点）
export function placeKnee(hip, ankle, guess, thigh, shin) {
  const d = sub(ankle, hip);
  const dist = Math.min(len(d), (thigh + shin) * 0.999); // 脚が伸びきる以上には離さない
  const axis = scale(d, 1 / (len(d) || 1));
  const a = (thigh ** 2 - shin ** 2 + dist ** 2) / (2 * dist); // 股関節から円の中心まで
  const r = Math.sqrt(Math.max(thigh ** 2 - a ** 2, 0));      // 円の半径
  const center = add(hip, scale(axis, a));
  const off = sub(guess, center);
  const perp = sub(off, scale(axis, dot(off, axis)));         // 脚の軸に直角な成分
  const k = len(perp);
  if (k < 1e-6) return { ...center, y: center.y + r };        // 向きが決まらないときは上側
  return add(center, scale(perp, r / k));
}

// 全フレームの脚を補正する。frames：選手基準の3D座標（null は人が見つからないフレーム）
export function stabilizeLegs(frames) {
  const valid = frames.filter(Boolean);
  if (valid.length < 3) return frames;
  const out = frames.map((f) => (f ? f.map((p) => ({ ...p })) : null));

  for (const side of ["left", "right"]) {
    // 1. 足を固定
    for (const i of FOOT[side]) {
      const fixed = medianPoint(valid.map((f) => f[i]));
      out.forEach((f) => f && (f[i] = { ...fixed, v: Math.max(f[i].v, 0.9) }));
    }
    // 2. 膝を長さで拘束（長さは全フレームの中央値）
    const { hip, knee, ankle } = LEG[side];
    const thigh = median(valid.map((f) => len(sub(f[knee], f[hip]))));
    const shin = median(valid.map((f) => len(sub(f[ankle], f[knee]))));
    out.forEach((f) => f && (f[knee] = { ...placeKnee(f[hip], f[ankle], f[knee], thigh, shin), v: f[knee].v }));
    // 3. 前後2フレームで平均して、もう一度拘束
    const smoothed = out.map((f, i) => {
      if (!f) return null;
      const near = out.slice(Math.max(0, i - 2), i + 3).filter(Boolean).map((g) => g[knee]);
      return scale(near.reduce(add, { x: 0, y: 0, z: 0 }), 1 / near.length);
    });
    out.forEach((f, i) => f && (f[knee] = { ...placeKnee(f[hip], f[ankle], smoothed[i], thigh, shin), v: f[knee].v }));
  }
  return out;
}

// ---- 足の置き方（全方向を合わせたモデル用） ----
// エルゴでの足の置き方：両足は前でそろえ、かかと同士は拳1個分（約10cm）離す。内股にはならない
export const HEEL_GAP = 0.1; // m（拳1個分）
const HEEL = { left: 29, right: 30 };
const SIDE_SIGN = { left: 1, right: -1 }; // X＝選手の左が＋

// frames：選手基準の3D座標（null はそのまま）
// 1. かかとの間を HEEL_GAP にし、足首・つま先も同じだけ左右にずらす（高さ・前後はそのまま）
// 2. 膝が「股関節と足首を結ぶ線」より内側に入らないようにする（内股にしない）
export function setFeet(frames) {
  return frames.map((f) => {
    if (!f) return f;
    const out = f.map((p) => ({ ...p }));
    const center = (f[HEEL.left].x + f[HEEL.right].x) / 2;
    for (const side of ["left", "right"]) {
      const shift = center + (SIDE_SIGN[side] * HEEL_GAP) / 2 - f[HEEL[side]].x;
      for (const i of FOOT[side]) out[i].x += shift;
      const { hip, knee, ankle } = LEG[side];
      // 膝が股関節〜足首の前後の何割の位置か（座っているので膝は股関節より高い。高さではなく前後で測る）
      const t = (out[knee].z - out[hip].z) / ((out[ankle].z - out[hip].z) || 1);
      const lineX = out[hip].x + (out[ankle].x - out[hip].x) * Math.min(Math.max(t, 0), 1);
      if ((out[knee].x - lineX) * SIDE_SIGN[side] < 0) out[knee].x = lineX; // 内側に入っていたら線の上へ
    }
    return out;
  });
}
