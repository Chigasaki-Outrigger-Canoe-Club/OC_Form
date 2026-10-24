// アウトリガーカヌーの漕ぎとして「ありえない」形を直す（明らかな推定の誤りだけを取り除く）
//
// 骨格推定は、手が体と重なったときなどに、腕が急に伸び縮みしたり、体が倒れすぎたりすることがある。
// 実際の漕ぎから大きく離れないよう、次の決まりを当てはめる（座標は選手基準：X＝左、Y＝上、Z＝前、単位m）：
//   1. 骨の長さは変わらない：上腕（肩〜肘）・前腕（肘〜手首）・首（肩の中心〜耳の中心）は、全フレームの中央値の長さにする
//   2. 胴の傾き：前へ LIMITS.leanForward°、後ろへ LIMITS.leanBack°、横へ LIMITS.leanSide° まで
//   3. 頭の傾き：胴に対して LIMITS.head° まで
// パドルの決まり（body3d.js の estimatePaddle で使う）：
//   4. ブレードは上の手より下（シャフトが LIMITS.shaftUp より上を向かない）
//   5. ブレードは漕ぐ側から大きく反対側へ行かない（シャフトの左右の向きが反対側へ LIMITS.shaftCross まで）
// 値はここで変えられる（角度は度）

import { P } from "./angles.js";

export const LIMITS = {
  leanForward: 60, // 胴の前傾（キャッチで深く倒しても 50° 前後）
  leanBack: 30,    // 胴の後傾（フィニッシュで少し倒れる程度）
  leanSide: 30,    // 胴の左右の傾き
  head: 45,        // 頭（首）の傾き（胴に対して）
  shaftUp: -0.2,   // シャフトの上下の向きの上限（−1＝真下、0＝水平）。これより上を向けない
  shaftCross: 0.35, // シャフトが漕ぐ側と反対へ向く量の上限（左右の成分）
};

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const len = (a) => Math.hypot(a.x, a.y, a.z);
const mid = (a, b) => scale(add(a, b), 0.5);
const median = (list) => { const v = list.filter((x) => x > 0).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] ?? 0; };
const RAD = Math.PI / 180;

// 腕：肩→肘→手首（手首から先の点＝小指・人差し指・親指は手首と一緒に動かす）
const ARMS = [
  { shoulder: P.lShoulder, elbow: P.lElbow, wrist: P.lWrist, hand: [17, 19, 21] },
  { shoulder: P.rShoulder, elbow: P.rElbow, wrist: P.rWrist, hand: [18, 20, 22] },
];
const HEAD = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const UPPER = [...HEAD, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]; // 腰より上

// 点の集まりを、中心 c のまわりに、向き from を向き to に回す（ロドリゲスの回転）
function rotateAll(f, ids, c, from, to) {
  const a = scale(from, 1 / (len(from) || 1));
  const b = scale(to, 1 / (len(to) || 1));
  const k = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  const sin = len(k);
  const cos = a.x * b.x + a.y * b.y + a.z * b.z;
  if (sin < 1e-9) return;
  const u = scale(k, 1 / sin);
  for (const i of ids) {
    const v = sub(f[i], c);
    const cross = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
    const dot = u.x * v.x + u.y * v.y + u.z * v.z;
    const r = add(add(scale(v, cos), scale(cross, sin)), scale(u, dot * (1 - cos)));
    f[i] = { ...f[i], ...add(c, r) };
  }
}

// 向き v（上向きが基本）を、前後・左右の傾きの上限に収めた向き
export function clampLean(v, forward, back, side) {
  const up = Math.max(v.y, 1e-6);
  const fwd = Math.atan2(v.z, up);   // 前へ＋
  const lat = Math.atan2(v.x, up);   // 左へ＋
  const f = Math.min(Math.max(fwd, -back * RAD), forward * RAD);
  const l = Math.min(Math.max(lat, -side * RAD), side * RAD);
  if (f === fwd && l === lat && v.y > 0) return v;
  const d = { x: Math.tan(l), y: 1, z: Math.tan(f) };
  return scale(d, len(v) / len(d));
}

// 全フレームの骨格を直した新しい配列を返す（null はそのまま）
export function plausibleBody(frames) {
  const valid = frames.filter(Boolean);
  if (!valid.length) return frames;
  const lengths = ARMS.map((a) => ({
    upper: median(valid.map((f) => len(sub(f[a.elbow], f[a.shoulder])))),
    fore: median(valid.map((f) => len(sub(f[a.wrist], f[a.elbow])))),
  }));
  const neck = median(valid.map((f) => len(sub(mid(f[P.lEar], f[P.rEar]), mid(f[P.lShoulder], f[P.rShoulder])))));

  return frames.map((frame) => {
    if (!frame) return frame;
    const f = frame.map((p) => ({ ...p }));
    const hip = mid(f[P.lHip], f[P.rHip]);
    // 2. 胴の傾き：腰より上をまとめて、腰の中心のまわりに回す
    const trunk = sub(mid(f[P.lShoulder], f[P.rShoulder]), hip);
    const okTrunk = clampLean(trunk, LIMITS.leanForward, LIMITS.leanBack, LIMITS.leanSide);
    if (okTrunk !== trunk) rotateAll(f, UPPER, hip, trunk, okTrunk);
    // 3. 頭の傾き：胴の向きに対して LIMITS.head° まで（首の付け根のまわりに頭を回す）
    const shoulder = mid(f[P.lShoulder], f[P.rShoulder]);
    const trunkNow = sub(shoulder, hip);
    const neckDir = sub(mid(f[P.lEar], f[P.rEar]), shoulder);
    const cos = (trunkNow.x * neckDir.x + trunkNow.y * neckDir.y + trunkNow.z * neckDir.z) / ((len(trunkNow) * len(neckDir)) || 1);
    if (Math.acos(Math.min(1, Math.max(-1, cos))) > LIMITS.head * RAD) {
      const t = scale(trunkNow, 1 / (len(trunkNow) || 1));
      const n = scale(neckDir, 1 / (len(neckDir) || 1));
      const along = scale(t, Math.cos(LIMITS.head * RAD));
      const offRaw = sub(n, scale(t, t.x * n.x + t.y * n.y + t.z * n.z));
      const target = add(along, scale(offRaw, Math.sin(LIMITS.head * RAD) / (len(offRaw) || 1)));
      rotateAll(f, HEAD, shoulder, neckDir, target);
    }
    // 1. 骨の長さ：首、上腕、前腕
    if (neck > 0) {
      const now = sub(mid(f[P.lEar], f[P.rEar]), shoulder);
      const move = sub(scale(now, neck / (len(now) || 1)), now);
      for (const i of HEAD) f[i] = { ...f[i], ...add(f[i], move) };
    }
    ARMS.forEach((a, k) => {
      const fix = (from, to, length, carry) => {
        const now = sub(f[to], f[from]);
        if (!length || len(now) < 1e-6) return;
        const move = sub(scale(now, length / len(now)), now);
        for (const i of [to, ...carry]) f[i] = { ...f[i], ...add(f[i], move) };
      };
      fix(a.shoulder, a.elbow, lengths[k].upper, [a.wrist, ...a.hand]);
      fix(a.elbow, a.wrist, lengths[k].fore, a.hand);
    });
    return f;
  });
}

// パドルの向き d（上の手→下の手、長さ1）を、漕ぐ側 side に合わせて決まりの中に収める
// 決まりから出た成分だけを上限にし、残りの成分は長さ1になるように伸び縮みさせる
export function plausibleShaft(d, side) {
  let v = { ...d };
  const limit = (axis, value) => {
    const others = ["x", "y", "z"].filter((a) => a !== axis);
    const rest = Math.hypot(...others.map((a) => v[a]));
    const k = rest > 1e-9 ? Math.sqrt(Math.max(0, 1 - value * value)) / rest : 0;
    v = { ...v, [axis]: value };
    for (const a of others) v[a] *= k;
  };
  if (v.y > LIMITS.shaftUp) limit("y", LIMITS.shaftUp); // 4. ブレードは上の手より下
  const sign = side === "left" ? 1 : side === "right" ? -1 : 0; // 漕ぐ側（X＝左が＋）
  if (sign && v.x * sign < -LIMITS.shaftCross) limit("x", -LIMITS.shaftCross * sign); // 5. 反対側へ行きすぎない
  return v;
}
