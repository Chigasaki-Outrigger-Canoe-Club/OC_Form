// 画像から木のシャフトを見つける（前・後ろの動画用）
//
// 手順（1フレームごと）：
//   1. 探す範囲：両手首のまわり（肩幅をもとに広げた四角）。シャフトは両手を通るため
//   2. 木の色の画素を拾う：色（色相）・あざやかさ・明るさが木の範囲にあるもの
//      木の色は動画ごとに少しずつ違うので、見つけたシャフトの上の色から覚え直す（learnWood）
//   3. 拾った画素の中から、いちばん長いまっすぐな線を探す（ハフ変換：角度2°・距離2pxごとに数える）
//   4. 線の上の画素が、両手の間の長さに比べて十分多ければ「シャフト」とする
// 戻り値の向き：画像上の単位ベクトル（下向きを正。ブレード側）

import { P } from "./angles.js";

// 木の色の初期値（色相 0〜360°、あざやかさ・明るさ 0〜1）。肌（色相が低め・あざやかさ低め）と分けるため狭めにする
// 肌は色相 10〜25° くらい（赤み）、木は 30〜45° くらい（黄み）なので、色相で分ける
export const WOOD = { hue: 38, hueRange: 12, satMin: 0.35, satMax: 0.9, valMin: 0.4 };
const ANGLE_STEP = Math.PI / 90; // 2°
const MIN_SUPPORT = 0.5;          // 線の上の画素が、両手の間の長さ（px）のこの割合以上で「シャフト」

export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max / 255 };
}

export const isWood = ({ h, s, v }, wood) => Math.abs(((h - wood.hue + 540) % 360) - 180) <= wood.hueRange && s >= wood.satMin && s <= wood.satMax && v >= wood.valMin;

// 探す範囲（画像のピクセル座標）：両手首を囲む四角を、肩幅の0.6倍ずつ広げる。下（ブレード側）はさらに広げる
export function searchBox(pose, width, height) {
  const a = pose[P.lWrist];
  const b = pose[P.rWrist];
  const shoulder = Math.hypot(pose[P.lShoulder].x - pose[P.rShoulder].x, pose[P.lShoulder].y - pose[P.rShoulder].y) || 100;
  const pad = shoulder * 0.6;
  return {
    x0: Math.max(0, Math.min(a.x, b.x) - pad), x1: Math.min(width, Math.max(a.x, b.x) + pad),
    y0: Math.max(0, Math.min(a.y, b.y) - pad), y1: Math.min(height, Math.max(a.y, b.y) + pad * 2),
    span: Math.max(Math.hypot(a.x - b.x, a.y - b.y), shoulder * 0.5), // 両手の間の長さ（px）
  };
}

// 範囲の中の木の色の画素 [[x, y], …]（image：ImageData 形式 { data, width, height }。座標は image のピクセル）
export function woodPixels(image, box, wood = WOOD) {
  const pts = [];
  for (let y = Math.floor(box.y0); y < box.y1; y++) {
    for (let x = Math.floor(box.x0); x < box.x1; x++) {
      const i = (y * image.width + x) * 4;
      if (isWood(rgbToHsv(image.data[i], image.data[i + 1], image.data[i + 2]), wood)) pts.push([x, y]);
    }
  }
  return pts;
}

// いちばん「細く長い」直線（ハフ変換）。戻り値：{ dir: [dx, dy]（下向き）, point: [x, y], votes }
//   床など木の色の広い面は、どの線にも点が乗るので、隣の線（8px 離れた線）より目立って多い線だけを数える
//   anchor から maxDist より遠い線は使わない（シャフトは両手の近くを通る）
const SIDE_BIN = 4; // 隣とみなす距離（2px × 4）
export function houghLine(pts, anchor = null, maxDist = Infinity) {
  if (pts.length < 2) return null;
  const cx = anchor ? anchor[0] : pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = anchor ? anchor[1] : pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let best = { score: 0 };
  for (let t = 0; t < Math.PI; t += ANGLE_STEP) {
    const nx = Math.cos(t);
    const ny = Math.sin(t); // 線の法線。距離 ρ = (点 − 中心)・法線
    const bins = new Map();
    for (const [x, y] of pts) {
      const r = Math.round(((x - cx) * nx + (y - cy) * ny) / 2);
      bins.set(r, (bins.get(r) ?? 0) + 1);
    }
    for (const [r, votes] of bins) {
      if (Math.abs(r * 2) > maxDist) continue;
      const score = votes - Math.max(bins.get(r - SIDE_BIN) ?? 0, bins.get(r + SIDE_BIN) ?? 0);
      if (score > best.score) best = { score, votes, t, rho: r * 2 };
    }
  }
  if (!best.score) return null;
  const nx = Math.cos(best.t);
  const ny = Math.sin(best.t);
  const dir = [-ny, nx]; // 法線に直角＝線の向き
  if (dir[1] < 0 || (dir[1] === 0 && dir[0] < 0)) { dir[0] = -dir[0]; dir[1] = -dir[1]; } // 下向きにそろえる
  return { dir, point: [cx + nx * best.rho, cy + ny * best.rho], votes: best.score };
}

// 1フレームのシャフト。image は縮小した画像、scale＝元の動画のピクセル ÷ image のピクセル
// 戻り値：{ dir: [dx, dy], point: [x, y]（元の動画のピクセル）, s: 確かさ 0〜1 } または null
export function detectShaft(image, scale, pose, wood = WOOD) {
  if (!pose) return null; // 手首の信頼度が低くても探す（手が見えにくいときこそ、写っているシャフトが役に立つ）
  const small = pose.map((p) => ({ ...p, x: p.x / scale, y: p.y / scale }));
  const box = searchBox(small, image.width, image.height);
  const a = small[P.lWrist];
  const b = small[P.rWrist];
  const line = houghLine(woodPixels(image, box, wood), [(a.x + b.x) / 2, (a.y + b.y) / 2], box.span * 0.5);
  if (!line) return null;
  const support = line.votes / (box.span * 1.5); // 太さ（数px）の分を見込んで割り引く
  if (support < MIN_SUPPORT) return null;
  return { dir: line.dir.map((v) => Math.round(v * 1000) / 1000), point: line.point.map((v) => Math.round(v * scale)), s: Math.min(1, Math.round(support * 100) / 100) };
}

// 見つけたシャフトの線の上の色から、木の色（色相）を覚え直す
export function learnWood(image, shaft, scale, wood = WOOD) {
  const hues = [];
  for (let k = -40; k <= 40; k++) {
    const x = Math.round(shaft.point[0] / scale + shaft.dir[0] * k);
    const y = Math.round(shaft.point[1] / scale + shaft.dir[1] * k);
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
    const i = (y * image.width + x) * 4;
    const c = rgbToHsv(image.data[i], image.data[i + 1], image.data[i + 2]);
    if (isWood(c, { ...wood, hueRange: wood.hueRange * 1.5 })) hues.push(c.h);
  }
  if (hues.length < 10) return wood;
  hues.sort((a, b) => a - b);
  return { ...wood, hue: hues[Math.floor(hues.length / 2)] };
}

// 時間に沿って、急に向きが変わった見つけ違いを外す（シャフトの角度は1コマで大きく変わらないため）
//   前後 WINDOW フレームの角度の中央値から MAX_TURN 以上ずれたものは null にする
const WINDOW = 5;
const MAX_TURN = (12 * Math.PI) / 180;
export function cleanShafts(list) {
  if (!list) return list;
  const angle = list.map((sh) => (sh ? Math.atan2(sh.dir[0], sh.dir[1]) : null)); // 縦からの傾き
  return list.map((sh, i) => {
    if (!sh) return sh;
    const near = angle.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).filter((a) => a != null).sort((a, b) => a - b);
    const median = near[Math.floor(near.length / 2)];
    return near.length >= 3 && Math.abs(angle[i] - median) > MAX_TURN ? null : sh;
  });
}
