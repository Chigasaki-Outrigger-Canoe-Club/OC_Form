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
