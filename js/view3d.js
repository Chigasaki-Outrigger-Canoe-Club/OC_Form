// 3Dビュー（Three.js）：人の形の3Dモデルとパドルを描く
// 操作：
//   マウス … ドラッグ＝回転、右ドラッグまたはShift＋ドラッグ＝移動、ホイール＝ズーム
//   スマホ … 1本指＝回転、2本指＝ピンチでズーム・そのまま動かすと移動
// 人の形は「関節の位置」から作った見た目で、体の表面を測ったものではない（解析には使わない）

// Three.js はCDNの「+esm」版を直接読む（import map が使えない古いスマホのブラウザでも読めるように）
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/+esm";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/controls/OrbitControls.js/+esm";
import { LineSegments2 } from "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/lines/LineSegments2.js/+esm";
import { LineSegmentsGeometry } from "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/lines/LineSegmentsGeometry.js/+esm";
import { LineMaterial } from "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/lines/LineMaterial.js/+esm";
import { JOINTS, colorOf } from "./overlay.js";
import { P } from "./angles.js";
import { bladeOutline } from "./body3d.js";

const FIXED = {
  front: { yaw: 0, pitch: 0.15 },
  left: { yaw: Math.PI / 2, pitch: 0.15 },
  right: { yaw: -Math.PI / 2, pitch: 0.15 },
  back: { yaw: Math.PI, pitch: 0.15 },
  top: { yaw: 0, pitch: 1.5 },
};
const TARGET = new THREE.Vector3(0, 0.6, 0);
const DISTANCE = 2.2;

// MediaPipe の手・足の点
const HAND = { left: [P.lWrist, 17, 19], right: [P.rWrist, 18, 20] }; // 手首、小指、人差し指
const FOOT = { left: [29, 31], right: [30, 32] };                      // かかと、つま先

// 腕・脚：[始点, 終点, 始点の半径, 終点の半径]（m、成人の目安）
const LIMBS = [
  [P.lShoulder, P.lElbow, 0.05, 0.04], [P.rShoulder, P.rElbow, 0.05, 0.04],   // 上腕
  [P.lElbow, P.lWrist, 0.04, 0.027], [P.rElbow, P.rWrist, 0.04, 0.027],       // 前腕
  [P.lHip, P.lKnee, 0.085, 0.055], [P.rHip, P.rKnee, 0.085, 0.055],           // 太もも
  [P.lKnee, P.lAnkle, 0.055, 0.033], [P.rKnee, P.rAnkle, 0.055, 0.033],       // すね
];
// 関節の丸み：[関節, 半径]
const ROUND = [
  [P.lShoulder, 0.05], [P.rShoulder, 0.05], [P.lElbow, 0.04], [P.rElbow, 0.04],
  [P.lWrist, 0.027], [P.rWrist, 0.027], [P.lKnee, 0.055], [P.rKnee, 0.055],
  [P.lAnkle, 0.033], [P.rAnkle, 0.033],
];
// 胴：背骨の5点（腰→肩）の断面の大きさ。幅＝腰幅・肩幅からの倍率、奥行き＝m
const TORSO_WIDTH = [1, 0.86, 0.82, 0.92, 1];
const TORSO_DEPTH = [0.1, 0.095, 0.1, 0.105, 0.085];
const RING = 24; // 断面の点の数

let renderer, camera, controls, scene3d;
let skin, bodyGroup, paddleGroup, trailGroup;
const parts = { limbs: [], rounds: [], hands: {}, feet: {}, markers: [] };
let torso, pelvis, neck, head;
let paddleKey = "";
let gripMarkers = []; // パドルの持ち手（上の手・下の手）の目印
const resolution = new THREE.Vector2(1, 1);

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const vec = (p) => new THREE.Vector3(p.x, p.y, p.z);
const mid = (a, b) => vec(a).add(vec(b)).multiplyScalar(0.5);

export function setupView3d(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  camera = new THREE.PerspectiveCamera(45, 1, 0.05, 50);
  controls = new OrbitControls(camera, canvas);
  controls.minDistance = 0.5;
  controls.maxDistance = 10;
  controls.addEventListener("change", render);

  scene3d = new THREE.Scene();
  scene3d.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(1.5, 3, 2);
  scene3d.add(sun);

  // 床のグリッド（0.25m間隔、±1.5m）と前方向の矢印
  scene3d.add(new THREE.GridHelper(3, 12, css("--muted"), css("--border")));
  scene3d.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.002, 0), 1.5, css("--muted"), 0.1, 0.05));
  const front = textSprite("前", css("--muted"));
  front.position.set(0, 0.05, 1.65);
  scene3d.add(front);

  skin = new THREE.MeshStandardMaterial({ color: css("--skin"), roughness: 0.75 });
  bodyGroup = new THREE.Group();
  paddleGroup = new THREE.Group();
  trailGroup = new THREE.Group();
  scene3d.add(bodyGroup, paddleGroup, trailGroup);
  buildBody();
  // 持ち手の目印：手首の点とは別に、パドルを握っている位置（手のひら）を示す
  const gripMaterial = new THREE.MeshBasicMaterial({ color: css("--paddle"), depthTest: false, transparent: true });
  gripMarkers = [0, 1].map(() => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), gripMaterial);
    m.renderOrder = 11;
    scene3d.add(m);
    return m;
  });

  placeCamera(0.6, 0.25, DISTANCE);
  new ResizeObserver(resize).observe(canvas);
}

// 固定視点（front / left / right / back / top）
export function setFixedView(name) {
  placeCamera(FIXED[name].yaw, FIXED[name].pitch, DISTANCE);
}

// 表示内容を更新する
// trails：[{ points: [{x,y,z}], color, drive: [true/false...] }]（drive が true の区間は赤・太めで描く）
// spine：背骨の点 [腰の中点, 30%, 50%, 70%, 肩の中点]（なければ腰と肩を直線で結ぶ）
export function updateView3d(body, paddle, trails, spine = null) {
  if (!renderer) return;
  bodyGroup.visible = Boolean(body);
  if (body) updateBody(body, spine);
  updatePaddle(paddle);
  updateTrails(trails);
  render();
}

// ---------- カメラ・描画 ----------

function placeCamera(yaw, pitch, distance) {
  const cp = Math.cos(pitch);
  controls.target.copy(TARGET);
  camera.position.set(cp * Math.sin(yaw), Math.sin(pitch), cp * Math.cos(yaw)).multiplyScalar(distance).add(TARGET);
  controls.update();
  render();
}

function resize() {
  const canvas = renderer.domElement;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  resolution.set(w, h);
  for (const line of trailGroup.children) line.material.resolution = resolution;
  render();
}

function render() {
  if (renderer) renderer.render(scene3d, camera);
}

function textSprite(text, color) {
  const c = Object.assign(document.createElement("canvas"), { width: 64, height: 64 });
  const g = c.getContext("2d");
  Object.assign(g, { fillStyle: color, font: "40px system-ui", textAlign: "center", textBaseline: "middle" });
  g.fillText(text, 32, 32);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c) }));
  sprite.scale.set(0.15, 0.15, 1);
  return sprite;
}

// mesh を「中心 center、縦軸 yAxis、横の向き xHint、大きさ size」に置く
function place(mesh, center, yAxis, xHint, size) {
  const y = yAxis.clone().normalize();
  const x = xHint.clone().addScaledVector(y, -xHint.dot(y));
  if (x.lengthSq() < 1e-8) x.set(Math.abs(y.x) < 0.9 ? 1 : 0, Math.abs(y.x) < 0.9 ? 0 : 1, 0).addScaledVector(y, -y.x);
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  mesh.matrix.makeBasis(x, y, z).scale(size).setPosition(center);
}

function addMesh(geometry, material = skin) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  bodyGroup.add(mesh);
  return mesh;
}

// ---------- 人の形 ----------

function buildBody() {
  const sphere = new THREE.SphereGeometry(1, 24, 16);
  for (const [, , r1, r2] of LIMBS) {
    // 長さ1の先細りの筒（y=0 が始点、y=1 が終点）。置くときに長さ方向へ伸ばす
    const g = new THREE.CylinderGeometry(r2, r1, 1, 20, 1, true).translate(0, 0.5, 0);
    parts.limbs.push(addMesh(g));
  }
  for (const [, r] of ROUND) parts.rounds.push(addMesh(new THREE.SphereGeometry(r, 20, 14)));
  for (const side of ["left", "right"]) {
    parts.hands[side] = addMesh(sphere);
    parts.feet[side] = addMesh(sphere);
  }
  pelvis = addMesh(sphere);
  head = addMesh(sphere);
  neck = addMesh(new THREE.CylinderGeometry(0.045, 0.052, 1, 20, 1, true).translate(0, 0.5, 0));

  // 胴：背骨に沿った断面（だ円）をつないだ筒。点の位置は毎回計算する
  const rings = TORSO_WIDTH.length + 2; // 上下に首と腰のふたの断面を足す
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(rings * RING * 3), 3));
  const index = [];
  for (let r = 0; r < rings - 1; r++) {
    for (let k = 0; k < RING; k++) {
      const a = r * RING + k, b = r * RING + ((k + 1) % RING), c = a + RING, d = b + RING;
      index.push(a, c, b, b, c, d);
    }
  }
  geometry.setIndex(index);
  torso = new THREE.Mesh(geometry, skin);
  bodyGroup.add(torso);

  // 関節の目印（体に隠れても見えるよう手前に描く）。半透明＝推定の信頼度が低い
  const dot = new THREE.SphereGeometry(0.016, 12, 8);
  for (const i of JOINTS) {
    const marker = new THREE.Mesh(dot, new THREE.MeshBasicMaterial({ color: colorOf(i), depthTest: false, transparent: true }));
    marker.renderOrder = 10;
    parts.markers.push([i, marker]);
    bodyGroup.add(marker);
  }
}

function updateBody(body, spine) {
  const at = (i) => vec(body[i]);
  const left = new THREE.Vector3(1, 0, 0);

  LIMBS.forEach(([a, b], n) => {
    const dir = at(b).sub(at(a));
    place(parts.limbs[n], at(a), dir, left, new THREE.Vector3(1, dir.length(), 1));
  });
  ROUND.forEach(([i], n) => place(parts.rounds[n], at(i), new THREE.Vector3(0, 1, 0), left, new THREE.Vector3(1, 1, 1)));

  // 手：手首から指の付け根の方向へのだ円体（指の点がおかしいときは前腕の向き）
  for (const [side, [wrist, pinky, index]] of Object.entries(HAND)) {
    const knuckles = mid(body[pinky], body[index]);
    let dir = knuckles.clone().sub(at(wrist));
    if (dir.length() < 0.02 || dir.length() > 0.2) dir = at(wrist).sub(at(side === "left" ? P.lElbow : P.rElbow));
    dir.normalize();
    const across = at(index).sub(at(pinky));
    place(parts.hands[side], at(wrist).addScaledVector(dir, 0.05), dir, across, new THREE.Vector3(0.042, 0.06, 0.02));
  }
  // 足：かかとからつま先へのだ円体
  for (const [side, [heel, toe]] of Object.entries(FOOT)) {
    const dir = at(toe).sub(at(heel));
    place(parts.feet[side], mid(body[heel], body[toe]), dir, left, new THREE.Vector3(0.045, Math.max(dir.length() / 2, 0.05), 0.035));
  }

  // 背骨の5点（なければ腰と肩の中点を直線で結ぶ）
  const hipMid = mid(body[P.lHip], body[P.rHip]);
  const shoulderMid = mid(body[P.lShoulder], body[P.rShoulder]);
  const points = spine ? spine.map(vec) : TORSO_WIDTH.map((_, i) => hipMid.clone().lerp(shoulderMid, i / (TORSO_WIDTH.length - 1)));
  const hipAxis = at(P.lHip).sub(at(P.rHip));
  const shoulderAxis = at(P.lShoulder).sub(at(P.rShoulder));
  updateTorso(points, hipAxis, shoulderAxis);

  const up = shoulderMid.clone().sub(hipMid).normalize();
  place(pelvis, hipMid.clone().addScaledVector(up, 0.03), up, hipAxis, new THREE.Vector3(hipAxis.length() * 0.8, 0.11, 0.1));

  // 首と頭：頭は両耳の中点を中心にしたたまご形
  const ears = mid(body[P.lEar], body[P.rEar]);
  const neckDir = ears.clone().sub(shoulderMid);
  place(neck, shoulderMid, neckDir, shoulderAxis, new THREE.Vector3(1, neckDir.length(), 1));
  place(head, ears.clone().addScaledVector(neckDir.clone().normalize(), 0.02), neckDir, at(P.lEar).sub(at(P.rEar)), new THREE.Vector3(0.08, 0.11, 0.095));

  for (const [i, marker] of parts.markers) {
    marker.position.copy(at(i));
    marker.material.opacity = body[i].v < 0.5 ? 0.3 : 1;
  }
}

// 胴の点を計算する。各断面は「横＝腰・肩の左右方向」「前＝横と背骨に直角な方向」のだ円
function updateTorso(points, hipAxis, shoulderAxis) {
  const last = points.length - 1;
  const hipHalf = hipAxis.length() * 0.75; // 腰の外側＝股関節の間隔の1.5倍の半分
  const shoulderHalf = shoulderAxis.length() / 2;
  const rings = points.map((p, i) => {
    const t = i / last;
    return {
      center: p,
      tangent: points[Math.min(i + 1, last)].clone().sub(points[Math.max(i - 1, 0)]).normalize(),
      side: hipAxis.clone().lerp(shoulderAxis, t),
      halfWidth: THREE.MathUtils.lerp(hipHalf, shoulderHalf, t) * TORSO_WIDTH[i],
      depth: TORSO_DEPTH[i],
    };
  });
  // 上下のふた：肩の上は首の太さへ、腰の下は小さくすぼめる
  const top = rings[last];
  const bottom = rings[0];
  rings.push({ ...top, center: top.center.clone().addScaledVector(top.tangent, 0.04), halfWidth: 0.07, depth: 0.06 });
  rings.unshift({ ...bottom, center: bottom.center.clone().addScaledVector(bottom.tangent, -0.04), halfWidth: bottom.halfWidth * 0.7, depth: 0.07 });

  const position = torso.geometry.attributes.position;
  rings.forEach((ring, r) => {
    const x = ring.side.clone().addScaledVector(ring.tangent, -ring.side.dot(ring.tangent)).normalize();
    const z = new THREE.Vector3().crossVectors(x, ring.tangent);
    for (let k = 0; k < RING; k++) {
      const angle = (2 * Math.PI * k) / RING;
      const p = ring.center.clone().addScaledVector(x, Math.cos(angle) * ring.halfWidth).addScaledVector(z, Math.sin(angle) * ring.depth);
      position.setXYZ(r * RING + k, p.x, p.y, p.z);
    }
  });
  position.needsUpdate = true;
  torso.geometry.computeVertexNormals();
  torso.geometry.computeBoundingSphere();
}

// ---------- パドル ----------
// パドルの座標：Tグリップが原点、y＝パドルの上方向、x＝ブレードの幅方向、z＝ブレード面の向き

function buildPaddle(pad) {
  paddleGroup.clear();
  const shaftLength = vec(pad.grip).distanceTo(vec(pad.bladeStart));
  const total = vec(pad.grip).distanceTo(vec(pad.tip));
  const bladeLength = total - shaftLength;
  const wood = new THREE.MeshStandardMaterial({ color: css("--paddle"), roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: css("--blade"), roughness: 0.4, side: THREE.DoubleSide });

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, shaftLength, 16).translate(0, -shaftLength / 2, 0), wood);
  const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.015, 0.08, 4, 12).rotateZ(Math.PI / 2), dark);

  const outline = bladeOutline(pad.bladeWidth, bladeLength).map((p) => new THREE.Vector2(p.x, p.y - shaftLength));
  const shape = new THREE.Shape();
  shape.moveTo(outline[0].x, outline[0].y);
  shape.splineThru(outline.slice(1));
  shape.closePath();
  const thickness = 0.008;
  const blade = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 6 }).translate(0, 0, -thickness / 2), dark);

  paddleGroup.add(shaft, grip, blade);
  paddleGroup.matrixAutoUpdate = false;
}

function updatePaddle(pad) {
  paddleGroup.visible = Boolean(pad);
  for (const m of gripMarkers) m.visible = Boolean(pad);
  if (!pad) return;
  gripMarkers[0].position.copy(vec(pad.grip));
  gripMarkers[1].position.copy(vec(pad.lowerGrip));
  // 寸法が変わったときだけ作り直す
  const key = [vec(pad.grip).distanceTo(vec(pad.bladeStart)), vec(pad.grip).distanceTo(vec(pad.tip)), pad.bladeWidth].map((x) => x.toFixed(3)).join();
  if (key !== paddleKey) {
    buildPaddle(pad);
    paddleKey = key;
  }
  const upward = vec(pad.grip).sub(vec(pad.tip));
  place(paddleGroup, vec(pad.grip), upward, vec(pad.widthDir), new THREE.Vector3(1, 1, 1));
}

// ---------- 軌跡 ----------

function updateTrails(trails) {
  for (const line of trailGroup.children) {
    line.geometry.dispose();
    line.material.dispose();
  }
  trailGroup.clear();
  const driveColor = new THREE.Color(css("--drive"));
  for (const drive of [false, true]) {
    const positions = [];
    const colors = [];
    for (const trail of trails) {
      const color = drive ? driveColor : new THREE.Color(trail.color);
      for (let i = 1; i < trail.points.length; i++) {
        const a = trail.points[i - 1];
        const b = trail.points[i];
        if (!a || !b || Boolean(trail.drive?.[i]) !== drive) continue;
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }
    }
    if (!positions.length) continue;
    const geometry = new LineSegmentsGeometry().setPositions(positions).setColors(colors);
    const material = new LineMaterial({ vertexColors: true, linewidth: drive ? 4 : 2 });
    material.resolution = resolution;
    trailGroup.add(new LineSegments2(geometry, material));
  }
}
