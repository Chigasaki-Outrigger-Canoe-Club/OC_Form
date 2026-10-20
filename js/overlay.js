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
export const COLOR = { left: "#ff8c1a", right: "#1ab2ff", manual: "#ff3b6b" };

export const colorOf = (i) => (LEFT.has(i) ? COLOR.left : COLOR.right);

export function drawSkeleton(canvas, lm) {
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
    ctx.fillStyle = p.src === "manual" ? COLOR.manual : colorOf(i);
    ctx.beginPath();
    ctx.arc(p.x, p.y, size * 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
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
