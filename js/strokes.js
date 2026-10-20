// ストローク区間の自動検出と、漕いでいる側（左右）の推定
//
// 考え方：
// - 手の高さ（低い方の手首）は1ストロークごとに上下する
// - 「手が最も高い時点」をストロークの区切りとする（キャッチ直前付近。キャッチ時点そのものではない）
// - 区切りと区切りの間で手が最も低い時点の「下の手」の側を、漕いでいる側と推定する
//   （パドルチェンジがあっても、ストロークごとに判定する）
// どちらも推定値。画面で手動修正できる。

import { P, MIN_VISIBILITY } from "./angles.js";

// 手の高さの指標：(低い方の手首のy − 腰の中点のy) ÷ 胴の長さ
// 値が大きいほど手が低い。画像の大きさや選手の大きさの影響を減らすため胴の長さで割る
export function handSignal(frames) {
  return frames.map((lm) => {
    if (!lm) return null;
    const pts = [P.lWrist, P.rWrist, P.lHip, P.rHip, P.lShoulder, P.rShoulder].map((i) => lm[i]);
    if (pts.some((p) => p.v < MIN_VISIBILITY)) return null;
    const [lw, rw, lh, rh, ls, rs] = pts;
    const hipY = (lh.y + rh.y) / 2;
    const torso = hipY - (ls.y + rs.y) / 2;
    if (torso <= 0) return null;
    return (Math.max(lw.y, rw.y) - hipY) / torso;
  });
}

// 移動平均（前後 half フレーム）。値なし（null）は除いて平均する
export function smooth(values, half) {
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (values[j] != null) { sum += values[j]; n++; }
    }
    return n ? sum / n : null;
  });
}

// 前後 gap フレーム以内で最大の点（極大）の位置。平均以下の小さな山は除く
export function findPeaks(values, gap) {
  const valid = values.filter((v) => v != null);
  const mean = valid.reduce((a, b) => a + b, 0) / (valid.length || 1);
  const peaks = [];
  values.forEach((v, i) => {
    if (v == null || v <= mean) return;
    for (let j = i - gap; j <= i + gap; j++) {
      const w = values[j];
      if (w == null || j === i) continue;
      if (w > v || (w === v && j < i)) return;
    }
    peaks.push(i);
  });
  return peaks;
}

// 下の手の側："left" / "right" / null
export function lowerHandSide(lm) {
  if (!lm) return null;
  const l = lm[P.lWrist];
  const r = lm[P.rWrist];
  if (l.v < MIN_VISIBILITY || r.v < MIN_VISIBILITY) return null;
  return l.y > r.y ? "left" : "right";
}

// 区切りの一覧 [{ frame, side, src }] を返す（src: "auto"＝自動検出、"manual"＝手動修正）
// side はその区切りから次の区切りまでのストロークの側（最後の区切りは null）
export function detectStrokes(frames, fps) {
  const signal = smooth(handSignal(frames), Math.max(1, Math.round(fps * 0.05)));
  const gap = Math.round(fps * 0.45);
  const tops = findPeaks(signal.map((v) => (v == null ? null : -v)), gap);

  return tops.map((frame, n) => {
    const next = tops[n + 1];
    if (next == null) return { frame, side: null, src: "auto" };
    let low = frame;
    for (let i = frame; i < next; i++) {
      if (signal[i] != null && (signal[low] == null || signal[i] > signal[low])) low = i;
    }
    return { frame, side: lowerHandSide(frames[low]), src: "auto" };
  });
}

// フレームが何番目のストロークに入るか（0始まり、区切りより前・最後の区切り以降は -1）
export function strokeIndexAt(frame, strokes) {
  for (let n = 0; n < strokes.length - 1; n++) {
    if (frame >= strokes[n].frame && frame < strokes[n + 1].frame) return n;
  }
  return -1;
}
