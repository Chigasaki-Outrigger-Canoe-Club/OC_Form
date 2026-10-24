// 推定の品質を数字で見る（評価用。推定そのものは変えない）
//
// 2D（画像のピクセル座標）で、関節ごとに次を計算する。大きさの違う動画でも比べられるよう、長さは「胴の長さ」に対する割合（%）
//   信頼度：visibility の中央値と、0.5 未満のフレームの割合
//   跳び：1フレームで胴の長さの JUMP 以上動いた回数（単発の誤検出の目安）
//   ぶれ：位置の2階差分（加速度のようなもの）の中央値（細かい揺れの目安。素早い動きでも大きくなる）
//   同じ位置でのばらつき：漕ぐ側ごとに、ストロークの同じ位置（0,5,…,100%）での位置の標準偏差の中央値
//     （同じ漕ぎを繰り返しているなら小さいはず。推定のぶれとフォームのばらつきの両方を含む）
//   正解とのずれ：人が付けた正解フレームでの距離（px と %）
// 注意：正解とのずれ以外は「正しさ」ではなく「安定さ」の目安

import { P } from "./angles.js";

export const JOINTS = [
  { i: P.lShoulder, label: "左肩" }, { i: P.rShoulder, label: "右肩" },
  { i: P.lElbow, label: "左肘" }, { i: P.rElbow, label: "右肘" },
  { i: P.lWrist, label: "左手首" }, { i: P.rWrist, label: "右手首" },
  { i: P.lHip, label: "左腰" }, { i: P.rHip, label: "右腰" },
  { i: P.lKnee, label: "左膝" }, { i: P.rKnee, label: "右膝" },
];
const JUMP = 0.25;

const median = (list) => {
  const v = list.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// 動画全体の胴の長さ（px）：肩の中点〜腰の中点の中央値
export function torsoLength(frames) {
  return median(frames.filter(Boolean).map((f) => dist(mid(f[P.lShoulder], f[P.rShoulder]), mid(f[P.lHip], f[P.rHip])))) || 1;
}

// 1つの関節の品質。frames：2D の骨格（null＝なし）、truth：{ フレーム: { 関節: {x,y} } }
export function jointQuality(frames, j, strokes = [], truth = {}) {
  const torso = torsoLength(frames);
  const pts = frames.map((f) => f?.[j] ?? null);
  const vis = pts.filter(Boolean).map((p) => p.v);
  let jumps = 0;
  const accel = [];
  for (let n = 1; n < pts.length; n++) {
    const [a, b, c] = [pts[n - 1], pts[n], pts[n + 1]];
    if (a && b && dist(a, b) > torso * JUMP) jumps++;
    if (a && b && c) accel.push(Math.hypot(a.x - 2 * b.x + c.x, a.y - 2 * b.y + c.y));
  }
  // 同じ位置でのばらつき（腰の中心からの位置で比べる。体全体が少し動いても影響しないように）
  const spreads = [];
  for (const side of ["right", "left"]) {
    const list = strokes.slice(0, -1).map((s, k) => ({ s, end: strokes[k + 1].frame })).filter((x) => x.s.side === side);
    if (list.length < 3) continue;
    for (let q = 0; q <= 100; q += 5) {
      const at = list.map(({ s, end }) => {
        const f = frames[Math.round(s.frame + ((end - 1 - s.frame) * q) / 100)];
        if (!f) return null;
        const hip = mid(f[P.lHip], f[P.rHip]);
        return { x: f[j].x - hip.x, y: f[j].y - hip.y };
      }).filter(Boolean);
      if (at.length < 3) continue;
      const m = { x: at.reduce((t, p) => t + p.x, 0) / at.length, y: at.reduce((t, p) => t + p.y, 0) / at.length };
      spreads.push(Math.sqrt(at.reduce((t, p) => t + (p.x - m.x) ** 2 + (p.y - m.y) ** 2, 0) / at.length));
    }
  }
  const errors = Object.entries(truth).filter(([n, t]) => t[j] && pts[n]).map(([n, t]) => dist(pts[n], t[j]));
  const pct = (v) => (v == null ? null : (v / torso) * 100);
  return {
    vis: median(vis),
    low: vis.length ? vis.filter((v) => v < 0.5).length / vis.length : null,
    jumps,
    jitter: pct(median(accel)),
    spread: pct(median(spreads)),
    errorPx: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
    error: pct(errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null),
    truthCount: errors.length,
  };
}

// 全関節の品質の表。戻り値：[{ label, i, raw: {...}, processed: {...} }]
export function qualityTable(raw, processed, strokes, truth) {
  return JOINTS.map(({ i, label }) => ({ i, label, raw: jointQuality(raw, i, strokes, truth), processed: jointQuality(processed, i, strokes, truth) }));
}
