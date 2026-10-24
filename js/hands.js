// 3D（world）を画像上の骨格（2D）に合わせる。あわせて手の位置を補正する
//
// MediaPipe の3D推定（world）は、画像上の骨格（2D）とは別に推定された値で、頭・首・手がずれやすい
// （実データの例：横からの動画で、首の傾きが画像と3Dで最大37°違った）。
// そこで、画面の縦・横の方向は2Dの骨格に合わせ、world はカメラの奥行き方向（z）だけに使う。
//
// 骨格推定（Pose）は手が小さく写るうえ、手どうし・体と重なると手首を見誤りやすい。
// そこで次の2つで、画像上（2D）の手の位置を直し、その分だけ3D（world）の点を動かす：
//   1. 手の専用推定（Hand Landmarker、手1つにつき21点）：手首・人差し指と小指の付け根
//   2. 人による補助：画面で点をドラッグして直したフレーム（前後のフレームにも少しずつ広げる）
// 2D→3D の移し方：
//   MediaPipe の world 座標の x・y は、画像の横・縦とほぼ同じ向き（奥行き z だけが別）。
//   フレームごとに「画像の1ピクセル＝worldの何m」を、肩・腰の点から最小二乗で求め（s）、
//   world の x・y ＝ 肩・腰の中心 ＋（2Dの点 − 2Dの肩・腰の中心）× s。奥行き z はそのまま

import { P } from "./angles.js";

// Pose の手の点：手首・小指の付け根・人差し指の付け根・親指
const POSE_HAND = { left: [P.lWrist, 17, 19, 21], right: [P.rWrist, 18, 20, 22] };
// Hand Landmarker から使う点（保存する順）：手首(0)・小指の付け根(17)・人差し指の付け根(5)
export const HAND_POINTS = [0, 17, 5];
const TORSO = [P.lShoulder, P.rShoulder, P.lHip, P.rHip];
export const SPREAD = 6; // 人が直したフレームの補正を、前後何フレームまで広げるか

const dist = (a, b) => Math.hypot(a[0] - b.x, a[1] - b.y);

// 1フレームの手の推定（最大2つ）を、Pose の左右の手首に近いほうへ割り当てる
// hands：[{ s: 信頼度, p: [[x,y] 手首, 小指, 人差し指] }]、pose：そのフレームの2D骨格
// 戻り値：{ left: [[x,y]×3] | null, right: ... }
export function assignHands(hands, pose) {
  const out = { left: null, right: null };
  if (!hands?.length || !pose) return out;
  const shoulder = Math.hypot(pose[P.lShoulder].x - pose[P.rShoulder].x, pose[P.lShoulder].y - pose[P.rShoulder].y) || 100;
  const pairs = [];
  hands.forEach((h, k) => ["left", "right"].forEach((side) => pairs.push({ k, side, d: dist(h.p[0], pose[POSE_HAND[side][0]]) })));
  pairs.sort((a, b) => a.d - b.d);
  const used = new Set();
  for (const { k, side, d } of pairs) {
    if (used.has(k) || out[side] || d > shoulder * 0.8) continue; // 遠すぎる手は別の物の見間違いとみなす
    out[side] = hands[k].p;
    used.add(k);
  }
  return out;
}

// 画像の1ピクセル＝worldの何m か（肩・腰の4点の、2Dと3Dの広がりの比）
export function pixelScale(pose, world) {
  const pts = TORSO.filter((i) => pose[i].v > 0.5);
  if (pts.length < 3) return null;
  const mean = (list, key) => list.reduce((s, p) => s + p[key], 0) / list.length;
  const p2 = pts.map((i) => pose[i]);
  const p3 = pts.map((i) => world[i]);
  const [u0, v0, x0, y0] = [mean(p2, "x"), mean(p2, "y"), mean(p3, "x"), mean(p3, "y")];
  let num = 0;
  let den = 0;
  pts.forEach((_, k) => {
    num += (p2[k].x - u0) * (p3[k].x - x0) + (p2[k].y - v0) * (p3[k].y - y0);
    den += (p2[k].x - u0) ** 2 + (p2[k].y - v0) ** 2;
  });
  return den > 0 && num > 0 ? num / den : null;
}

// 人が直した点の「元の推定からの移動量」（2D）。直していなければ null
const manualShift = (p) => (p?.src === "manual" && p.ox != null ? [p.x - p.ox, p.y - p.oy] : null);

// 1フレームの2Dの移動量 { 関節番号: [dx, dy] }
//   手の専用推定 → 人の補助（そのフレーム、または前後 SPREAD フレームから距離に応じて弱めて）の順に重ねる
//   人の補助は手以外の点（肩・腰など）にも使う
function handShifts(pose, hands, n) {
  const shifts = {};
  const assigned = assignHands(hands[n], pose[n]);
  for (const side of ["left", "right"]) {
    const h = assigned[side];
    if (!h) continue;
    const [wrist, pinky, index, thumb] = POSE_HAND[side];
    const base = (i) => [pose[n][i].ox ?? pose[n][i].x, pose[n][i].oy ?? pose[n][i].y];
    [wrist, pinky, index].forEach((i, k) => { const b = base(i); shifts[i] = [h[k][0] - b[0], h[k][1] - b[1]]; });
    shifts[thumb] = shifts[wrist];
  }
  // 人の補助：近いフレームほど強く（そのフレーム＝100%、SPREAD フレーム先＝0%）
  for (let d = -SPREAD; d <= SPREAD; d++) {
    const f = pose[n + d];
    if (!f) continue;
    const w = 1 - Math.abs(d) / (SPREAD + 1);
    f.forEach((p, i) => {
      const m = manualShift(p);
      if (!m) return;
      const own = shifts[i] ?? [0, 0];
      shifts[i] = [own[0] * (1 - w) + m[0] * w, own[1] * (1 - w) + m[1] * w];
    });
  }
  return shifts;
}

// 全フレームの world を、2Dの骨格（手の専用推定・人の補助で直したもの）に合わせた新しい配列を返す（元は変えない）
// world・pose：フレームごとの配列（null＝人が見つからない）、hands：フレームごとの手の推定（なければ省略）
export function correctWorld(world, pose, hands = []) {
  if (!world || !pose) return world;
  return world.map((w, n) => {
    if (!w || !pose[n]) return w;
    const s = pixelScale(pose[n], w);
    if (!s) return w;
    const shifts = handShifts(pose, hands, n);
    const torso = TORSO.filter((i) => pose[n][i].v > 0.5);
    const center2 = average(torso.map((i) => [pose[n][i].ox ?? pose[n][i].x, pose[n][i].oy ?? pose[n][i].y]));
    const center3 = average(torso.map((i) => [w[i].x, w[i].y]));
    return w.map((p, i) => {
      const q = pose[n][i];
      const [dx, dy] = shifts[i] ?? [0, 0];
      return {
        ...p,
        x: center3[0] + ((q.ox ?? q.x) + dx - center2[0]) * s,
        y: center3[1] + ((q.oy ?? q.y) + dy - center2[1]) * s,
        v: shifts[i] ? Math.max(p.v, 0.9) : p.v,
      };
    });
  });
}

const average = (list) => [0, 1].map((k) => list.reduce((sum, p) => sum + p[k], 0) / list.length);
