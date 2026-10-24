// 動画の上に骨格を描く・関節をドラッグで修正する
// キャンバスは動画と同じピクセル数で作り、CSSの object-fit: contain で動画とぴったり重ねる

import { P, MIN_VISIBILITY } from "./angles.js";

// 骨格線（つなぐ関節の組み合わせ）
export const BONES = [
  [P.lEar, P.rEar], [P.nose, P.lEar], [P.nose, P.rEar], // 頭
  [P.lEar, P.lShoulder], [P.rEar, P.rShoulder],          // 首
  [P.lShoulder, P.rShoulder], [P.lHip, P.rHip],
  [P.lShoulder, P.lElbow], [P.lElbow, P.lWrist], [P.rShoulder, P.rElbow], [P.rElbow, P.rWrist],
  [P.lShoulder, P.lHip], [P.rShoulder, P.rHip],
  [P.lHip, P.lKnee], [P.lKnee, P.lAnkle], [P.rHip, P.rKnee], [P.rKnee, P.rAnkle],
];

// 描く関節（頭は鼻・両耳。目・口・指先は除く）
export const JOINTS = Object.values(P);

const LEFT = new Set([P.lEar, P.lShoulder, P.lElbow, P.lWrist, P.lHip, P.lKnee, P.lAnkle]);
export const COLOR = { left: "#ff8c1a", right: "#1ab2ff", manual: "#ff3b6b", hand: "#ffffff", shaft: "#ff2bd6", truth: "#22e06b" };
// 信頼度で色分けするとき：0.8以上＝緑、0.5〜0.8＝黄、0.5未満＝赤
const confidenceColor = (v) => (v >= 0.8 ? "#22c55e" : v >= 0.5 ? "#facc15" : "#ef4444");

export const colorOf = (i) => (LEFT.has(i) ? COLOR.left : COLOR.right);

// hands：手の専用推定（そのフレーム）。白い輪で、手首・小指と人差し指の付け根を描く
// shaft：画像から見つけたシャフト（そのフレーム）。ピンクの点線で描く
// options.byConfidence：関節の点を信頼度で色分けする、options.truth：人が付けた正解 { 関節番号: {x,y} }（緑の十字）
export function drawSkeleton(canvas, lm, hands = null, shaft = null, options = {}) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!lm) return;
  const size = canvas.width / 300; // 動画の大きさに合わせた線の太さ

  ctx.lineWidth = size;
  for (const [a, b] of BONES) {
    ctx.globalAlpha = Math.min(lm[a].v, lm[b].v) < MIN_VISIBILITY ? 0.3 : 1;
    ctx.strokeStyle = colorOf(b);
    ctx.beginPath();
    ctx.moveTo(lm[a].x, lm[a].y);
    ctx.lineTo(lm[b].x, lm[b].y);
    ctx.stroke();
  }

  for (const i of JOINTS) {
    const p = lm[i];
    ctx.globalAlpha = p.v < MIN_VISIBILITY ? 0.3 : 1;
    ctx.fillStyle = p.src === "manual" ? COLOR.manual : options.byConfidence ? confidenceColor(p.v) : colorOf(i);
    ctx.beginPath();
    ctx.arc(p.x, p.y, size * 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (shaft) {
    const len = canvas.height * 0.6;
    ctx.strokeStyle = COLOR.shaft;
    ctx.setLineDash([size * 4, size * 3]);
    ctx.beginPath();
    ctx.moveTo(shaft.point[0] - shaft.dir[0] * len, shaft.point[1] - shaft.dir[1] * len);
    ctx.lineTo(shaft.point[0] + shaft.dir[0] * len, shaft.point[1] + shaft.dir[1] * len);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = COLOR.truth;
  ctx.lineWidth = size;
  for (const t of Object.values(options.truth ?? {})) {
    const r = size * 4;
    ctx.beginPath();
    ctx.moveTo(t.x - r, t.y); ctx.lineTo(t.x + r, t.y);
    ctx.moveTo(t.x, t.y - r); ctx.lineTo(t.x, t.y + r);
    ctx.stroke();
  }
  ctx.strokeStyle = COLOR.hand;
  for (const h of hands ?? []) {
    for (const [x, y] of h.p) {
      ctx.beginPath();
      ctx.arc(x, y, size * 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// 画面上のマウス位置 → 動画のピクセル座標（object-fit: contain の余白を考慮）
export function toVideoPoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  const offsetX = (rect.width - canvas.width * scale) / 2;
  const offsetY = (rect.height - canvas.height * scale) / 2;
  return {
    x: (event.clientX - rect.left - offsetX) / scale,
    y: (event.clientY - rect.top - offsetY) / scale,
    scale,
  };
}

// マウス位置に最も近い関節の番号（画面上で15px以内、なければ null）
export function nearestJoint(lm, point) {
  let best = null;
  let bestDist = 15 / point.scale;
  for (const i of JOINTS) {
    const d = Math.hypot(lm[i].x - point.x, lm[i].y - point.y);
    if (d < bestDist) { best = i; bestDist = d; }
  }
  return best;
}
