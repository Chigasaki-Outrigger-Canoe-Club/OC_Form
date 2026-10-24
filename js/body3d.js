// 3D表示用の計算（表示処理から分離）
//
// 入力：MediaPipe の worldLandmarks（腰の中心が原点、単位はおよそメートル）
//   MediaPipe の向き：x＝画像の右、y＝下、z＝カメラから遠ざかる向き
// 出力：選手の体を基準にした座標（単位m）
//   X＝選手の左、Y＝上、Z＝選手の前、床＝Y=0
// 注意：1台のカメラからの推定値。奥行き（カメラ方向）の精度は低い。

import { P } from "./angles.js";
import { cleanShafts } from "./shaft.js";
import { plausibleShaft } from "./constraints.js";

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

// パドルの持ち手（推定値）：人差し指と小指の付け根の中点
// パドルは手首ではなく手のひらで握るため。手首を曲げたときの「手首と手の位置の違い」をパドルに反映する
// 指の付け根が見えないとき（信頼度0.5未満）は手首を使う
const HAND_POINTS = { left: [P.lWrist, 17, 19], right: [P.rWrist, 18, 20] }; // 手首、小指の付け根、人差し指の付け根
export function gripPoint(body, hand) {
  const [wrist, pinky, index] = HAND_POINTS[hand].map((i) => body[i]);
  if (!pinky || !index || pinky.v < 0.5 || index.v < 0.5) return wrist;
  return { x: (pinky.x + index.x) / 2, y: (pinky.y + index.y) / 2, z: (pinky.z + index.z) / 2, v: Math.min(pinky.v, index.v) };
}

// 簡易パドルの推定（推定値）
// 仮定：上の手の持ち手がTグリップ（パドルの上端）、シャフトは上の手の持ち手から下の手の持ち手の方向へ伸びる
// size：{ length, bladeLength, bladeWidth }（m）
// side：そのストロークの漕ぐ側（"left"/"right"）。漕ぐ側の手＝下の手に固定し、ストロークの途中で左右が入れ替わらないようにする
//       わからないとき（null）だけ、高いほうの手を上の手とみなす
// 戻り値：{ grip, lowerGrip, bladeStart, tip, widthDir, bladeWidth, side } または null（手が見えない・両手が近すぎる）
// shaft：画像から見つけたシャフトの向き（選手基準、前・後ろの動画から。なければ null）
//   あれば、カメラの面（前・後ろなら左右と上下）の向きはシャフトに合わせ、前後の成分は両手から決めたままにする
export function estimatePaddle(body, size, side = null, shaft = null) {
  if (!body) return null;
  if (body[P.lWrist].v < 0.5 || body[P.rWrist].v < 0.5) return null;
  const l = gripPoint(body, "left");
  const r = gripPoint(body, "right");

  const bottom = side === "left" ? l : side === "right" ? r : l.y >= r.y ? r : l;
  const top = bottom === l ? r : l;
  if (length(sub(bottom, top)) < 0.05) return null;

  // 両手から向きを決め → 画像のシャフトに合わせ → 漕ぎとしてありえない向き（上向き・反対側）を直す
  const dir = plausibleShaft(alignToShaft(normalize(sub(bottom, top)), shaft), bottom === l ? "left" : "right");
  return paddleAlong(top, bottom, dir, size, bottom === l ? "left" : "right");
}

// 上の手 top からの向き dir でパドルを置く
function paddleAlong(top, bottom, dir, size, side) {
  // ブレード面の幅方向：シャフトと前後方向（Z）の両方に直角＝ブレード面は前を向く
  let widthDir = cross(dir, { x: 0, y: 0, z: 1 });
  if (length(widthDir) < 0.1) widthDir = { x: 1, y: 0, z: 0 };
  return {
    grip: { x: top.x, y: top.y, z: top.z },
    lowerGrip: { x: bottom.x, y: bottom.y, z: bottom.z },
    bladeStart: add(top, scale(dir, size.length - size.bladeLength)),
    tip: add(top, scale(dir, size.length)),
    widthDir: normalize(widthDir),
    bladeWidth: size.bladeWidth,
    side,
    src: "est",
  };
}

// 並んだフレーム（またはストロークの位相）のパドルを、向きがなめらかになるように作る
// 両手が近いと、両手を結ぶ向きは少しのずれで大きく回ってしまう（パドルが飛ぶ）。そこで
//   重み＝両手の距離（TRUST_FROM〜TRUST_TO m で 0.05〜1）として、前後 ±4 コマの向きを重み付きで平均する
//   漕ぐ側が変わるところ（パドルチェンジ）はまたがない
// bodies・sides・shafts：同じ長さの配列（shafts は省略可）
const TRUST_FROM = 0.1;
const TRUST_TO = 0.4;
export function paddleTrack(bodies, size, sides, shafts = []) {
  const raw = bodies.map((b, i) => estimatePaddle(b, size, sides[i], shafts[i] ?? null));
  const dirs = raw.map((p) => p && normalize(sub(p.tip, p.grip)));
  const trust = raw.map((p) => (p ? Math.min(1, Math.max(0.05, (length(sub(p.lowerGrip, p.grip)) - TRUST_FROM) / (TRUST_TO - TRUST_FROM))) : 0));
  return raw.map((p, i) => {
    if (!p) return p;
    let sum = { x: 0, y: 0, z: 0 };
    for (let k = -4; k <= 4; k++) {
      const j = i + k;
      if (!raw[j] || raw[j].side !== p.side) continue;
      sum = add(sum, scale(dirs[j], Math.exp(-(k * k) / 8) * trust[j]));
    }
    return paddleAlong(p.grip, p.lowerGrip, plausibleShaft(normalize(sum), p.side), size, p.side);
  });
}

// 両手から決めた向き d の、左右・上下の成分の向きを、シャフトの向きに合わせる（長さと前後の成分はそのまま）
export function alignToShaft(d, shaft) {
  if (!shaft) return d;
  const m = Math.hypot(d.x, d.y);
  const h = Math.hypot(shaft.x, shaft.y);
  if (h < 0.3) return d; // シャフトがカメラの奥行き方向を向いていて、画像では向きがわからない
  const sign = d.x * shaft.x + d.y * shaft.y < 0 ? -1 : 1; // ブレード側（下向き）にそろえる
  return normalize({ x: (sign * shaft.x * m) / h, y: (sign * shaft.y * m) / h, z: d.z });
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

// 画像から見つけたシャフトの向き（フレームごと）→ 選手基準の向き（長さ1）と確かさ { x, y, z, s } の配列
// 急に向きが変わった見つけ違いは外す（cleanShafts）
// 画像の横・縦は MediaPipe の world の x・y と同じ向きなので、toBodyFrame と同じ反転・回転をかける
export function shaftToBody(worldFrames, shafts) {
  if (!shafts || !worldFrames) return null;
  const angle = bodyAngle(worldFrames.map((f) => (f ? f.map(flip) : null)));
  return cleanShafts(shafts).map((sh) => sh && { ...normalize(rotateY({ x: sh.dir[0], y: -sh.dir[1], z: 0, v: 1 }, angle)), s: sh.s });
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
