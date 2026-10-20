// 3Dビュー（Canvasで簡易3D骨格とパドルを描く）
// 操作：ドラッグ＝回転、Shift＋ドラッグまたは右ドラッグ＝移動、ホイール＝ズーム

import { cameraBasis, project, add, scale } from "./body3d.js";
import { BONES, JOINTS, colorOf } from "./overlay.js";
import { P } from "./angles.js";

const FIXED = {
  front: { yaw: 0, pitch: 0.15 },
  left: { yaw: Math.PI / 2, pitch: 0.15 },
  right: { yaw: -Math.PI / 2, pitch: 0.15 },
  back: { yaw: Math.PI, pitch: 0.15 },
  top: { yaw: 0, pitch: 1.5 },
};

const view = { yaw: 0.6, pitch: 0.25, distance: 2.2, target: { x: 0, y: 0.6, z: 0 } };
let canvas = null;
let scene = { body: null, paddle: null, trails: [] };

const cssColor = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function setupView3d(element) {
  canvas = element;
  let last = null;

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    last = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (last.pan) {
      const cam = cameraBasis(view);
      const k = view.distance / 600;
      view.target = add(view.target, add(scale(cam.right, -dx * k), scale(cam.up, dy * k)));
    } else {
      view.yaw -= dx * 0.01;
      view.pitch = Math.min(1.5, Math.max(-1.5, view.pitch + dy * 0.01));
    }
    last = { ...last, x: e.clientX, y: e.clientY };
    draw();
  });
  canvas.addEventListener("pointerup", () => (last = null));
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.distance = Math.min(10, Math.max(0.8, view.distance * (e.deltaY > 0 ? 1.1 : 0.9)));
    draw();
  }, { passive: false });
}

// 固定視点（front / left / right / back / top）
export function setFixedView(name) {
  Object.assign(view, FIXED[name], { target: { x: 0, y: 0.6, z: 0 }, distance: 2.2 });
  draw();
}

// 表示内容を更新する
// trails：[{ points: [{x,y,z}], color, drive: [true/false...] }]（drive が true の区間は赤で描く）
// spine：背骨の点 [腰の中点, 30%, 50%, 70%, 肩の中点]（なければ腰と肩を直線で結ぶ）
export function updateView3d(body, paddle, trails, spine = null) {
  scene = { body, paddle, trails, spine };
  draw();
}

// 肉付き：体の各部を「太さのある棒（カプセル）」で表す。半径は成人の目安（m）
const FLESH = [
  [P.lShoulder, P.lElbow, 0.045], [P.rShoulder, P.rElbow, 0.045], // 上腕
  [P.lElbow, P.lWrist, 0.035], [P.rElbow, P.rWrist, 0.035],       // 前腕
  [P.lHip, P.lKnee, 0.075], [P.rHip, P.rKnee, 0.075],             // 大腿
  [P.lKnee, P.lAnkle, 0.05], [P.rKnee, P.rAnkle, 0.05],           // 下腿
  [P.lAnkle, 31, 0.035], [P.rAnkle, 32, 0.035],                   // 足
  [P.lShoulder, P.rShoulder, 0.06],                                // 肩まわり
  [P.lHip, P.rHip, 0.085],                                         // 骨盤
];
const TORSO_RADIUS = [0.11, 0.115, 0.12, 0.125]; // 背骨の区間ごとの胴の半径（腰→胸）

function draw() {
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  const cam = cameraBasis(view);
  const focal = h * 1.2;
  const to2d = (p) => project(p, cam, w, h, focal);

  const line = (a, b, color, width) => {
    const pa = to2d(a);
    const pb = to2d(b);
    if (!pa || !pb) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width * ratio;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  };

  // 床のグリッド（0.25m間隔、±1.5m）と前方向の目印
  for (let i = -6; i <= 6; i++) {
    const d = i * 0.25;
    line({ x: d, y: 0, z: -1.5 }, { x: d, y: 0, z: 1.5 }, cssColor("--border"), 1);
    line({ x: -1.5, y: 0, z: d }, { x: 1.5, y: 0, z: d }, cssColor("--border"), 1);
  }
  line({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1.5 }, cssColor("--muted"), 2);
  const front = to2d({ x: 0, y: 0, z: 1.6 });
  if (front) {
    ctx.fillStyle = cssColor("--muted");
    ctx.font = `${12 * ratio}px system-ui`;
    ctx.fillText("前", front.x, front.y);
  }

  // 軌跡（力を入れている区間＝赤・太め）
  for (const trail of scene.trails) {
    for (let i = 1; i < trail.points.length; i++) {
      if (!trail.points[i - 1] || !trail.points[i]) continue;
      const drive = trail.drive?.[i];
      line(trail.points[i - 1], trail.points[i], drive ? cssColor("--drive") : trail.color, drive ? 3 : 1.5);
    }
  }

  // 骨格
  const body = scene.body;
  if (body) {
    drawFlesh(ctx, body, scene.spine, cam, w, h, focal);
    if (scene.spine) {
      for (let i = 1; i < scene.spine.length; i++) line(scene.spine[i - 1], scene.spine[i], cssColor("--text"), 2);
    }
    for (const [a, b] of BONES) {
      if (scene.spine && [P.lShoulder, P.rShoulder].includes(a) && [P.lHip, P.rHip].includes(b)) continue; // 胴の横線は背骨で表す
      ctx.globalAlpha = Math.min(body[a].v, body[b].v) < 0.5 ? 0.3 : 1;
      line(body[a], body[b], colorOf(b), 3);
    }
    for (const i of JOINTS) {
      const p = to2d(body[i]);
      if (!p) continue;
      ctx.globalAlpha = body[i].v < 0.5 ? 0.3 : 1;
      ctx.fillStyle = colorOf(i);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 * ratio, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // パドル（シャフト＝線、ブレード＝四角形）
  const pad = scene.paddle;
  if (pad) {
    const paddleColor = cssColor("--paddle");
    line(pad.grip, pad.bladeStart, paddleColor, 3);
    const half = scale(pad.widthDir, pad.bladeWidth / 2);
    const corners = [add(pad.bladeStart, half), add(pad.tip, half), add(pad.tip, scale(half, -1)), add(pad.bladeStart, scale(half, -1))].map(to2d);
    if (corners.every(Boolean)) {
      ctx.fillStyle = paddleColor;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  ctx.fillStyle = cssColor("--drive");
  ctx.font = `${12 * ratio}px system-ui`;
  ctx.fillText("赤線＝力を入れている区間（手の動きからの推定）", 16 * ratio, h - 12 * ratio);

  if (!body) {
    ctx.fillStyle = cssColor("--muted");
    ctx.font = `${14 * ratio}px system-ui`;
    ctx.fillText("骨格推定を行うと3D骨格が表示されます", 16 * ratio, 28 * ratio);
  }
}

// 肉付きを描く：カプセルを奥から順に重ねる（手前のものが上に来る）
function drawFlesh(ctx, body, spine, cam, w, h, focal) {
  const mid = (a, b) => scale(add(a, b), 0.5);
  const torso = spine ?? [mid(body[P.lHip], body[P.rHip]), mid(body[P.lShoulder], body[P.rShoulder])];
  const neckTop = mid(body[P.lEar], body[P.rEar]);
  const parts = [
    ...FLESH.map(([a, b, r]) => [body[a], body[b], r]),
    ...torso.slice(1).map((p, i) => [torso[i], p, TORSO_RADIUS[Math.min(i, 3)]]),
    [torso.at(-1), neckTop, 0.05], // 首
  ];
  const projected = parts
    .map(([a, b, r]) => ({ a: project(a, cam, w, h, focal), b: project(b, cam, w, h, focal), r }))
    .filter((p) => p.a && p.b)
    .sort((p, q) => q.a.depth + q.b.depth - (p.a.depth + p.b.depth));

  ctx.lineCap = "round";
  ctx.strokeStyle = cssColor("--skin");
  ctx.globalAlpha = 0.55;
  for (const p of projected) {
    ctx.lineWidth = (2 * p.r * focal) / ((p.a.depth + p.b.depth) / 2);
    ctx.beginPath();
    ctx.moveTo(p.a.x, p.a.y);
    ctx.lineTo(p.b.x, p.b.y);
    ctx.stroke();
  }
  // 頭：両耳の中点を中心に半径10cmの球
  const c = project(neckTop, cam, w, h, focal);
  if (c) {
    ctx.fillStyle = cssColor("--skin");
    ctx.beginPath();
    ctx.arc(c.x, c.y, (0.1 * focal) / c.depth, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = "butt";
}

window.addEventListener("resize", draw);
