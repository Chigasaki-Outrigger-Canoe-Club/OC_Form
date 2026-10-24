// フォームの数値を、動画の画面上の点（2D）から測る（10/25 の方針A：3Dモデルは参考に下げ、2Dを主役にする）
//
// 何のため：1台のカメラの3Dは奥行きが推測で、4本は同時撮影でもないため、合わせた3Dは実際と違いやすい。
//           画面に写った位置そのもの（2D）は、カメラに平行な向きの動きなら正確に測れる。
// 方向ごとに測るもの：
//   横（右・左）：カメラ側を漕いでいるストロークだけ（右の動画＝右漕ぎ、左の動画＝左漕ぎ。下の手が手前で隠れないため）
//                 前傾、前傾〜起こしの幅、キャッチのリーチ、抜きの位置、上の手の高さ、下の手の肘、ドライブの割合、手の軌道、背中の丸まり
//   前・後ろ：シャフトの左右の傾き（前だけ）、肩の傾き、骨盤の傾き（後ろだけ）、体幹の左右の傾き
// cm への換算：胴の長さ（腰の中点〜肩の中点）を身長の 29% とみなす（人体の平均的な比率。目安）

import { P } from "./angles.js";
import { resampleStroke, averageStrokes, resampleSeries, averageSeries, PHASES } from "./fusion.js";
import { sideMetrics } from "./feedback.js";
import { detectDrive } from "./drive.js";

export const TORSO_RATIO = 0.29;
const deg = (rad) => (rad * 180) / Math.PI;
const median = (v) => { const s = v.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = (v) => { const s = v.filter((x) => x != null); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
const mid2 = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const hipMid = (f) => mid2(f[P.lHip], f[P.rHip]);
const shoulderMid = (f) => mid2(f[P.lShoulder], f[P.rShoulder]);
const torsoPx = (f) => Math.hypot(shoulderMid(f).x - hipMid(f).x, shoulderMid(f).y - hipMid(f).y);

// 横の動画の2D（画素）→ 選手基準の座標（m）。z＝前（顔の向き）、y＝上、x＝0（横からは左右がわからない）
// 原点＝腰の中点の中央値。heightCm＝身長（なければ 170cm とみなす）
export function sideFrames(pose, heightCm) {
  const valid = pose.filter(Boolean);
  if (!valid.length) return null;
  const facing = Math.sign(median(valid.map((f) => f[P.nose].x - hipMid(f).x)) || 1);
  const scale = ((heightCm || 170) * TORSO_RATIO) / 100 / median(valid.map(torsoPx)); // m／画素
  const ox = median(valid.map((f) => hipMid(f).x));
  const oy = median(valid.map((f) => hipMid(f).y));
  return pose.map((f) => f && f.map((p) => ({ x: 0, y: (oy - p.y) * scale, z: (p.x - ox) * facing * scale, v: p.v })));
}

// 平均に使うストローク：漕ぐ側が合い、長さが中央値の ±25% に入るもの（区切りの見つけ違い・休みを除く）
export function goodStrokes(strokes, side) {
  const all = strokes.slice(0, -1).map((s, n) => ({ ...s, end: strokes[n + 1].frame }));
  const m = median(all.map((s) => s.end - s.frame));
  return all.filter((s) => s.side === side && Math.abs(s.end - s.frame - m) <= m * 0.25);
}

// 漕ぐ側ごとの代表ストローク（位相ごとの平均）。frames は sideFrames の出力または2Dの点
function representative(frames, strokes, side) {
  const list = goodStrokes(strokes, side).map((s) => resampleStroke(frames, s.frame, s.end));
  return list.length ? { frames: averageStrokes(list), count: list.length } : null;
}

function representativeSeries(series, strokes, side) {
  if (!series) return null;
  const list = goodStrokes(strokes, side).map((s) => resampleSeries(series, s.frame, s.end));
  return list.length ? averageSeries(list) : null;
}

// 横の動画（カメラ側の漕ぎだけ）の指標。view：{ name, pose, strokes, spine }
// 戻り値：{ metrics, count, drive: { start, end }（0〜1） } | null
export function sideViewMetrics(view, heightCm) {
  const side = view.name; // 右の動画＝右漕ぎ、左の動画＝左漕ぎ
  const frames = sideFrames(view.pose, heightCm);
  const rep = frames && representative(frames, view.strokes, side);
  if (!rep) return null;
  const m = sideMetrics(rep.frames, side, representativeSeries(view.spine, view.strokes, side), []);
  if (!m) return null;
  m.rotationRange = null; // ねじれは横からの2Dでは測れない
  const drive = detectDrive(rep.frames, side);
  return { metrics: m, count: rep.count, drive: drive ? { start: drive.start / (PHASES - 1), end: drive.end / (PHASES - 1) } : null };
}

// 前・後ろの動画の指標（画面上の角度、度）。漕ぐ側を基準に、プラス＝漕ぐ側へ傾く・漕ぐ側が下がる
//   前から撮ると選手の左は画面の右、後ろからは画面の左
// view：{ name: "front"|"back", pose, strokes, shaft }、side：漕ぐ側、drive：横の動画のドライブ区間（0〜1。なければ 0〜0.4）
export function frontBackMetrics(view, side, drive) {
  const rep = representative(view.pose, view.strokes, side);
  if (!rep) return null;
  const toLeft = view.name === "front" ? 1 : -1;               // 画面の右＝選手の左（前）、画面の左＝選手の左（後ろ）
  const toward = side === "left" ? toLeft : -toLeft;           // 漕ぐ側が画面のどちら向きか（x の符号）
  const [a, b] = drive ? [drive.start, drive.end] : [0, 0.4];
  const range = rep.frames.slice(Math.round(a * (PHASES - 1)), Math.round(b * (PHASES - 1)) + 1).filter(Boolean);
  const pair = (l, r) => (side === "left" ? [l, r] : [r, l]);   // [漕ぐ側, 反対側]

  // 漕ぐ側の点が反対側よりどれだけ下か（度）。画面の y は下向き
  const drop = (f, l, r) => {
    const [own, other] = pair(f[l], f[r]);
    if (Math.min(own.v, other.v) < 0.5) return null;
    return deg(Math.atan2(own.y - other.y, Math.abs(own.x - other.x)));
  };
  // 体幹（腰→肩）の、漕ぐ側への傾き（度）
  const lean = (f) => {
    const s = shoulderMid(f);
    const h = hipMid(f);
    return deg(Math.atan2((s.x - h.x) * toward, h.y - s.y));
  };
  return {
    count: rep.count,
    shoulderTilt: mean(range.map((f) => drop(f, P.lShoulder, P.rShoulder))),
    hipTilt: view.name === "back" ? mean(range.map((f) => drop(f, P.lHip, P.rHip))) : null,
    trunkSide: mean(range.map(lean)),
    shaftTilt: view.name === "front" ? shaftTilt(view, side, a, b) : null,
  };
}

// シャフトの左右の傾き（度、ドライブ区間の平均）：画像から見つけたシャフトの線。なければ両手首を結ぶ線
function shaftTilt(view, side, a, b) {
  const angles = [];
  goodStrokes(view.strokes, side).forEach((s) => {
    const len = s.end - s.frame;
    for (let k = Math.round(s.frame + a * len); k <= Math.round(s.frame + b * len); k++) {
      const sh = view.shaft?.[k];
      const f = view.pose[k];
      if (sh) angles.push(deg(Math.atan2(Math.abs(sh.dir[0]), Math.abs(sh.dir[1]))));
      else if (f && Math.min(f[P.lWrist].v, f[P.rWrist].v) >= 0.5) {
        angles.push(deg(Math.atan2(Math.abs(f[P.lWrist].x - f[P.rWrist].x), Math.abs(f[P.lWrist].y - f[P.rWrist].y))));
      }
    }
  });
  return angles.length ? mean(angles) : null;
}

// 全方向をまとめる → { right: {...指標}, left: {...}, used: { 指標: [方向] } }
// views：[{ name, pose（2D・画素）, strokes, spine, shaft }]、heightCm：身長
export function form2d(views, heightCm) {
  const out = { right: null, left: null, counts: { right: {}, left: {} } };
  for (const side of ["right", "left"]) {
    const sideView = views.find((v) => v.name === side && v.pose);
    const s = sideView ? sideViewMetrics(sideView, heightCm) : null;
    const metrics = { ...(s?.metrics ?? {}) };
    if (s) out.counts[side][side] = s.count;
    const fb = views.filter((v) => (v.name === "front" || v.name === "back") && v.pose)
      .map((v) => [v.name, frontBackMetrics(v, side, s?.drive)]).filter(([, m]) => m);
    for (const key of ["shoulderTilt", "hipTilt", "trunkSide", "shaftTilt"]) {
      metrics[key] = mean(fb.map(([, m]) => m[key])); // 前と後ろの両方で測れたものは平均
    }
    fb.forEach(([name, m]) => (out.counts[side][name] = m.count));
    out[side] = Object.values(metrics).some((v) => v != null) ? metrics : null;
  }
  return out;
}
