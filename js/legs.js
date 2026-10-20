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
