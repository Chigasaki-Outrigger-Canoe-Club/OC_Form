// 3D表示用の計算（表示処理から分離）
//
// 入力：MediaPipe の worldLandmarks（腰の中心が原点、単位はおよそメートル）
//   MediaPipe の向き：x＝画像の右、y＝下、z＝カメラから遠ざかる向き
// 出力：選手の体を基準にした座標（単位m）
//   X＝選手の左、Y＝上、Z＝選手の前、床＝Y=0
// 注意：1台のカメラからの推定値。奥行き（カメラ方向）の精度は低い。

import { P } from "./angles.js";

const HEEL_L = 29, HEEL_R = 30, TOE_L = 31, TOE_R = 32;

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const length = (a) => Math.hypot(a.x, a.y, a.z);
const normalize = (a) => scale(a, 1 / (length(a) || 1));
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

function median(values) {
  const v = values.filter((n) => n != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

// MediaPipe の向き → X右・Y上・Z手前
const flip = (p) => ({ x: p.x, y: -p.y, z: -p.z, v: p.v });

// Y軸まわりの回転
function rotateY(p, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c, v: p.v };
}

// 動画全体を選手基準の座標に変換する
// 向き：全フレームの「右の腰・肩 → 左の腰・肩」方向の中央値を X に合わせる（動画ごとに1つの回転）
//   フレームごとに回さないので、体幹の回旋はそのまま残る
// 床：足首・かかと・つま先の最も低い点の中央値を Y=0 とする
// 選手の左をXに合わせるための回転角
function bodyAngle(flipped) {
  const leftX = [];
  const leftZ = [];
  for (const f of flipped) {
    if (!f) continue;
    const left = add(sub(f[P.lHip], f[P.rHip]), sub(f[P.lShoulder], f[P.rShoulder]));
    leftX.push(left.x);
    leftZ.push(left.z);
  }
  return Math.atan2(median(leftZ), median(leftX));
}

export function toBodyFrame(worldFrames) {
  const flipped = worldFrames.map((f) => (f ? f.map(flip) : null));
  const angle = bodyAngle(flipped);

  const rotated = flipped.map((f) => (f ? f.map((p) => rotateY(p, angle)) : null));
  const floor = median(rotated.map((f) => (f
    ? Math.min(...[P.lAnkle, P.rAnkle, HEEL_L, HEEL_R, TOE_L, TOE_R].map((i) => f[i].y))
    : null)));

  return rotated.map((f) => (f ? f.map((p) => ({ ...p, y: p.y - floor })) : null));
}

// 簡易パドルの推定（推定値）
// 仮定：上の手がTグリップ（パドルの上端）を持ち、シャフトは上の手から下の手の方向へ伸びる
// size：{ length, bladeLength, bladeWidth }（m）
// side：そのストロークの漕ぐ側（"left"/"right"）。漕ぐ側の手＝下の手に固定し、ストロークの途中で左右が入れ替わらないようにする
//       わからないとき（null）だけ、高いほうの手を上の手とみなす
// 戻り値：{ grip, bladeStart, tip, widthDir, bladeWidth, side } または null（手が見えない・両手が近すぎる）
export function estimatePaddle(body, size, side = null) {
  if (!body) return null;
  const l = body[P.lWrist];
  const r = body[P.rWrist];
  if (l.v < 0.5 || r.v < 0.5) return null;

  const bottom = side === "left" ? l : side === "right" ? r : l.y >= r.y ? r : l;
  const top = bottom === l ? r : l;
  if (length(sub(bottom, top)) < 0.05) return null;

  const dir = normalize(sub(bottom, top));
  // ブレード面の幅方向：シャフトと前後方向（Z）の両方に直角＝ブレード面は前を向く
  let widthDir = cross(dir, { x: 0, y: 0, z: 1 });
  if (length(widthDir) < 0.1) widthDir = { x: 1, y: 0, z: 0 };

  return {
    grip: { x: top.x, y: top.y, z: top.z },
    bladeStart: add(top, scale(dir, size.length - size.bladeLength)),
    tip: add(top, scale(dir, size.length)),
    widthDir: normalize(widthDir),
    bladeWidth: size.bladeWidth,
    side: bottom === l ? "left" : "right",
    src: "est",
  };
}

// ブレードの輪郭：首（シャフトとの境目）が細く、先端寄りで最も広く、先は丸くとがる涙形
// [ブレード長に対する位置, 最大幅に対する幅]。アウトリガー用パドル（PILIなど）の写真を目安にした
const BLADE_PROFILE = [[0, 0.1], [0.1, 0.35], [0.25, 0.62], [0.45, 0.85], [0.65, 0.98], [0.78, 1], [0.88, 0.9], [0.95, 0.65], [0.985, 0.35], [1, 0]];

// 輪郭の点（ブレード面の座標：x＝幅方向、y＝首が0で先端が −length）。右側→先端→左側の順
export function bladeOutline(width, length) {
  const right = BLADE_PROFILE.map(([t, w]) => ({ x: (w * width) / 2, y: -t * length }));
  const left = right.slice(0, -1).reverse().map((p) => ({ x: -p.x, y: p.y }));
  return [...right, ...left];
}

// ---- 表示用のカメラ計算 ----
// view：{ yaw, pitch, distance, target }（角度はラジアン）
// yaw=0 で選手の正面（+Z側）から見る
export function cameraBasis(view) {
  const cp = Math.cos(view.pitch);
  const position = add(view.target, scale({
    x: cp * Math.sin(view.yaw), y: Math.sin(view.pitch), z: cp * Math.cos(view.yaw),
  }, view.distance));
  const forward = normalize(sub(view.target, position));
  const right = normalize(cross(forward, { x: 0, y: 1, z: 0 }));
  const up = cross(right, forward);
  return { position, forward, right, up };
}

// 3D点 → 画面座標（focal＝焦点距離のピクセル数）。カメラの後ろの点は null
export function project(p, cam, width, height, focal) {
  const v = sub(p, cam.position);
  const depth = v.x * cam.forward.x + v.y * cam.forward.y + v.z * cam.forward.z;
  if (depth <= 0.01) return null;
  const x = v.x * cam.right.x + v.y * cam.right.y + v.z * cam.right.z;
  const y = v.x * cam.up.x + v.y * cam.up.y + v.z * cam.up.z;
  return { x: width / 2 + (focal * x) / depth, y: height / 2 - (focal * y) / depth, depth };
}

// 選手から見たカメラの方向（選手基準の座標、長さ1）
// 例：左側から撮った動画 → (1, 0, 0)、後ろから → (0, 0, -1)
// この方向がカメラの奥行き方向で、1台のカメラでは最も精度が低い
export function cameraDirection(worldFrames) {
  const angle = bodyAngle(worldFrames.map((f) => (f ? f.map(flip) : null)));
  const dir = rotateY({ x: 0, y: 0, z: 1, v: 1 }, angle);
  return { x: dir.x, y: 0, z: dir.z };
}

export { add, scale, median };
