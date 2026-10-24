// 骨格推定の補助：推定に自信がないフレームを選ぶ（人が点を直すフレームの提案）
//
// 自信のなさ（フレームごと、手首と肩）：
//   1 − MediaPipe の信頼度
//   ＋ 手の専用推定が見つからない手 0.5
//   ＋ 手の専用推定と Pose の手首のずれ（肩幅に対する割合）
// 選び方：ストロークの中から自信のなさが大きい順に、近すぎるフレーム（0.3秒以内）を飛ばして count 個

import { P } from "./angles.js";
import { assignHands } from "./hands.js";

const JOINTS = [
  { i: P.lWrist, side: "left", label: "左手首" },
  { i: P.rWrist, side: "right", label: "右手首" },
  { i: P.lShoulder, label: "左肩" },
  { i: P.rShoulder, label: "右肩" },
];

// 1フレームの、点ごとの自信のなさ [{ label, score }]
export function frameDoubt(pose, hands) {
  if (!pose) return [];
  const shoulder = Math.hypot(pose[P.lShoulder].x - pose[P.rShoulder].x, pose[P.lShoulder].y - pose[P.rShoulder].y) || 100;
  const assigned = assignHands(hands, pose);
  return JOINTS.map(({ i, side, label }) => {
    let score = 1 - pose[i].v;
    if (side) {
      const h = assigned[side];
      score += h ? Math.hypot(h[0][0] - pose[i].x, h[0][1] - pose[i].y) / shoulder : 0.5;
    }
    return { label, score: pose[i].src === "manual" ? 0 : score }; // 直した点は自信ありとする
  });
}

// 補助してほしいフレームを選ぶ。戻り値：[{ frame, score, weak: ["左手首", …] }]（時間順）
export function suggestFrames(pose, hands, strokes, fps, count = 10) {
  if (!pose || strokes.length < 2) return [];
  const start = strokes[0].frame;
  const end = strokes[strokes.length - 1].frame;
  const candidates = [];
  for (let f = start; f < end; f++) {
    const doubt = frameDoubt(pose[f], hands?.[f]);
    if (!doubt.length) continue;
    const score = doubt.reduce((s, d) => s + d.score, 0);
    candidates.push({ frame: f, score, weak: doubt.filter((d) => d.score > 0.4).map((d) => d.label) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const gap = Math.round(fps * 0.3);
  const picked = [];
  for (const c of candidates) {
    if (picked.length >= count) break;
    if (picked.some((p) => Math.abs(p.frame - c.frame) < gap)) continue;
    picked.push(c);
  }
  return picked.sort((a, b) => a.frame - b.frame);
}
