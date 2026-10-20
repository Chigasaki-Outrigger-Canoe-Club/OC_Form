// フォームのコメント（改善候補）
//
// 統合3Dモデル（代表ストローク）とストロークの時間から、いくつかの指標を計算し、
// 目安から外れたものを「改善候補」として示す。
// 注意：
// - 目安の値は一般的な指導ポイントをもとにした「暫定値」で、科学的に検証したものではない
// - 3Dは1台ずつのカメラからの推定を合わせたもので、誤差を含む
// - 本人の基準フォームとの比較（MVP 4）ができたら、目安はそちらに置き換える予定
// 目安を変えるときは下の LIMITS だけを直す。

import { P } from "./angles.js";

export const LIMITS = {
  trunkRange: 15,    // 体幹の前傾〜起こしの幅（度）。これより小さいと改善候補
  rotationRange: 15, // 上体の回旋（肩の線と腰の線のねじれ）の幅（度）。これより小さいと改善候補
  bottomElbow: 140,  // 引きの途中の下の手の肘の角度（度）。これより小さい（曲がる）と改善候補
  shaftTilt: 20,     // 引きの途中のシャフトの左右の傾き（度、正面から見て）。これより大きいと改善候補
  rhythmCV: 10,      // ストローク時間のばらつき（変動係数 %）。これより大きいと改善候補
};

const deg = (rad) => (rad * 180) / Math.PI;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const range = (values) => Math.max(...values) - Math.min(...values);

// 3D空間での点bの角度（度）
export function angle3d(a, b, c) {
  const u = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const dot = u.x * v.x + u.y * v.y + u.z * v.z;
  const len = Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z);
  return deg(Math.acos(Math.min(1, Math.max(-1, dot / (len || 1)))));
}

// 体幹の前傾（度）：腰の中点→肩の中点 が鉛直から前（+Z）へ傾く角度
export function trunkPitch(f) {
  const s = mid(f[P.lShoulder], f[P.rShoulder]);
  const h = mid(f[P.lHip], f[P.rHip]);
  return deg(Math.atan2(s.z - h.z, s.y - h.y));
}

// 上体の回旋（度）：上から見た肩の線と腰の線の角度の差
export function trunkRotation(f) {
  const yaw = (l, r) => Math.atan2(l.z - r.z, l.x - r.x);
  let d = deg(yaw(f[P.lShoulder], f[P.rShoulder]) - yaw(f[P.lHip], f[P.rHip]));
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// 1つの側（右漕ぎ・左漕ぎ）の代表ストロークの指標
export function sideMetrics(frames, side) {
  const valid = frames.filter(Boolean);
  if (valid.length < frames.length * 0.8) return null; // 欠けが多いときは計算しない
  const bottom = side === "right" ? { s: P.rShoulder, e: P.rElbow, w: P.rWrist } : { s: P.lShoulder, e: P.lElbow, w: P.lWrist };
  const topWrist = side === "right" ? P.lWrist : P.rWrist;

  // 引きの途中＝下の手が最も低い位相
  const pull = valid.reduce((low, f) => (f[bottom.w].y < low[bottom.w].y ? f : low));
  const shaft = { x: pull[bottom.w].x - pull[topWrist].x, y: pull[bottom.w].y - pull[topWrist].y };

  return {
    trunkRange: range(valid.map(trunkPitch)),
    rotationRange: range(valid.map(trunkRotation)),
    bottomElbow: angle3d(pull[bottom.s], pull[bottom.e], pull[bottom.w]),
    shaftTilt: deg(Math.atan2(Math.abs(shaft.x), Math.abs(shaft.y))),
  };
}

// ストローク時間のばらつき（全方向の動画から）
export function rhythm(views) {
  const seconds = [];
  for (const v of views) {
    v.strokes.forEach((s, n) => {
      const next = v.strokes[n + 1];
      if (next) seconds.push((next.frame - s.frame) / v.fps);
    });
  }
  if (seconds.length < 3) return null;
  const mean = seconds.reduce((a, b) => a + b, 0) / seconds.length;
  const sd = Math.sqrt(seconds.reduce((a, b) => a + (b - mean) ** 2, 0) / (seconds.length - 1));
  return { spm: 60 / mean, cv: (sd / mean) * 100, count: seconds.length };
}

// 指標ごとの説明（項目名・単位・目安から外れたときのコメント）
const ITEMS = [
  { key: "trunkRange", label: "体幹の前傾〜起こしの幅", unit: "°", bad: (v) => v < LIMITS.trunkRange,
    comment: "体幹の動きが小さめです。腕だけで引いている可能性があります。キャッチで股関節から前に倒し、引きで起こす動きを確認してください。" },
  { key: "rotationRange", label: "上体の回旋（ねじれ）の幅", unit: "°", bad: (v) => v < LIMITS.rotationRange,
    comment: "上体のねじれが小さめです。キャッチで漕ぐ側の肩を前に出し、ねじりを戻す力で引けているか確認してください。" },
  { key: "bottomElbow", label: "引きの途中の下の手の肘", unit: "°", bad: (v) => v < LIMITS.bottomElbow,
    comment: "下の手の肘が曲がりやすいようです。腕で引くより、肘を伸ばして体幹で引く意識を確認してください。" },
  { key: "shaftTilt", label: "引きの途中のシャフトの左右の傾き", unit: "°", bad: (v) => v > LIMITS.shaftTilt,
    comment: "シャフトが左右に傾いています。上の手を下の手の真上に重ね、パドルを立てて引けているか確認してください。" },
];

// コメントの一覧を作る
// fused：fuseViews の結果、views：[{ strokes, fps }]
export function buildFeedback(fused, views) {
  const metrics = { right: fused.right && sideMetrics(fused.right.frames, "right"), left: fused.left && sideMetrics(fused.left.frames, "left") };
  const rows = ITEMS.map((item) => {
    const values = { right: metrics.right?.[item.key] ?? null, left: metrics.left?.[item.key] ?? null };
    const flagged = Object.entries(values).filter(([, v]) => v != null && item.bad(v)).map(([side]) => side);
    return { ...item, values, flagged };
  });

  const r = rhythm(views);
  rows.push({
    key: "rhythmCV", label: "ストローク時間のばらつき", unit: "%",
    values: { all: r?.cv ?? null }, extra: r ? `平均 ${r.spm.toFixed(1)} spm、${r.count} ストローク` : "",
    flagged: r && r.cv > LIMITS.rhythmCV ? ["all"] : [],
    comment: "ストロークの時間にばらつきがあります。一定のリズムで漕げているか確認してください（パドルチェンジ前後は乱れやすい）。",
  });
  return rows;
}
