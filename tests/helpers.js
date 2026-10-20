// テスト用の模擬骨格データを作る
import { P } from "../js/angles.js";

// 全関節を同じ点で埋めた33点の骨格
function blank() {
  return Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 1, src: "est" }));
}

// 漕ぐ動きを模した骨格。side＝下の手の側、phase＝0〜1（0＝手が最も高い）
export function rowingPose(side, phase) {
  const lm = blank();
  const set = (i, x, y) => (lm[i] = { x, y, v: 1, src: "est" });
  set(P.lShoulder, 90, 100); set(P.rShoulder, 110, 100);
  set(P.lHip, 90, 200); set(P.rHip, 110, 200);
  set(P.lElbow, 80, 150); set(P.rElbow, 120, 150);
  set(P.lKnee, 60, 210); set(P.rKnee, 140, 210);
  set(P.lAnkle, 40, 260); set(P.rAnkle, 160, 260);
  set(P.nose, 100, 50); set(P.lEar, 92, 55); set(P.rEar, 108, 55);
  // 下の手：高さが周期的に変わる。上の手：肩より上
  const lowY = 150 + 60 * (1 - Math.cos(phase * 2 * Math.PI)) / 2;
  const highY = 60;
  set(P.lWrist, 85, side === "left" ? lowY : highY);
  set(P.rWrist, 115, side === "right" ? lowY : highY);
  return lm;
}

// sides の順にストロークを並べた動画（1ストローク＝period フレーム）
export function rowingSequence(sides, period) {
  const frames = [];
  for (const side of sides) {
    for (let i = 0; i < period; i++) frames.push(rowingPose(side, i / period));
  }
  frames.push(rowingPose(sides.at(-1), 0)); // 最後の区切り
  return frames;
}

// 選手基準の座標（X左・Y上・Z前、単位m）で座った姿勢を作る
export function seatedBody() {
  const b = Array.from({ length: 33 }, () => ({ x: 0, y: 0.5, z: 0, v: 1 }));
  const set = (i, x, y, z) => (b[i] = { x, y, z, v: 1 });
  set(P.lHip, 0.15, 0.5, 0); set(P.rHip, -0.15, 0.5, 0);
  set(P.lShoulder, 0.2, 1.0, 0.1); set(P.rShoulder, -0.2, 1.0, 0.1);
  set(P.lKnee, 0.15, 0.6, 0.45); set(P.rKnee, -0.15, 0.6, 0.45);
  set(P.lAnkle, 0.15, 0.1, 0.8); set(P.rAnkle, -0.15, 0.1, 0.8);
  [29, 30, 31, 32].forEach((i, k) => set(i, k % 2 ? -0.15 : 0.15, 0.1, 0.85));
  set(P.lWrist, 0.1, 1.4, 0.4); set(P.rWrist, -0.1, 0.9, 0.5);
  set(P.nose, 0, 1.25, 0.2); set(P.lEar, 0.07, 1.22, 0.1); set(P.rEar, -0.07, 1.22, 0.1);
  return b;
}

// 選手基準 → MediaPipe の向き（カメラに対して angle だけ回し、y下・z奥に戻す）
export function toMediaPipe(body, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return body.map((p) => {
    const x = p.x * c - p.z * s;
    const z = p.x * s + p.z * c;
    return { x, y: -(p.y - 0.5), z: -z, v: 1 };
  });
}

