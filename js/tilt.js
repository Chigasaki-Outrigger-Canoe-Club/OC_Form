// 肩の傾き（左右の肩の高さの差）を使って、ストロークを区切る・漕ぐ側を決める・位相をそろえる
//
// 何のため：
//   後ろの動画は手首・肘がほとんど見えず（信頼度0.5未満が9割）、手の高さでストロークを区切れない。
//   一方、肩はどの方向からもよく見え、肩の傾きはストロークごとにはっきり上下する（10/24 の後ろの動画で周期 33〜34 フレーム＝横の動画のストロークと同じ）。
//   そこで肩の傾きで区切り、漕ぐ側と位相（ストロークの何%か）は横の動画の肩の傾きに合わせる。
// 肩の傾き＝左肩の高さ − 右肩の高さ（選手基準の座標、m。プラス＝左肩が高い）

import { P } from "./angles.js";
import { findPeaks, smooth } from "./strokes.js";

const MIN_V = 0.5;

// フレームごとの肩の傾き（肩が見えないフレームは null）
export function shoulderTilt(body) {
  return body.map((f) => (f && f[P.lShoulder].v >= MIN_V && f[P.rShoulder].v >= MIN_V ? f[P.lShoulder].y - f[P.rShoulder].y : null));
}

// 前後 half フレームの中央値（ふだんの傾き。ここからの外れ＝ストロークの山）
function rollingMedian(values, half) {
  return values.map((_, i) => {
    const v = values.slice(Math.max(0, i - half), i + half + 1).filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  });
}

// 肩の傾きでストロークを区切る [{ frame, side: null, src: "tilt" }]
//   区切り＝ふだんの傾き（前後1秒の中央値）から最も外れた時点。漕ぐ側はあとで fillSides で決める
export function tiltStrokes(body, fps) {
  const tilt = smooth(shoulderTilt(body), Math.max(1, Math.round(fps * 0.05)));
  const base = rollingMedian(tilt, Math.round(fps));
  const away = tilt.map((v, i) => (v == null || base[i] == null ? null : Math.abs(v - base[i])));
  return findPeaks(away, Math.round(fps * 0.45)).map((frame) => ({ frame, side: null, src: "tilt" }));
}

// 1ストロークの肩の傾きの平均
function strokeTilt(tilt, start, end) {
  const v = tilt.slice(start, end).filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// 漕ぐ側ごとのふだんの肩の傾き { right, left }（漕ぐ側がわかっているストロークから。なければ null）
// views：[{ body, strokes }]
export function sideTilt(views) {
  const sums = { right: [], left: [] };
  for (const { body, strokes } of views) {
    const tilt = shoulderTilt(body);
    strokes.forEach((s, n) => {
      const next = strokes[n + 1];
      const t = next && sums[s.side] ? strokeTilt(tilt, s.frame, next.frame) : null;
      if (t != null) sums[s.side].push(t);
    });
  }
  const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  return { right: mean(sums.right), left: mean(sums.left) };
}

// 漕ぐ側がわからないストローク（side: null）に、肩の傾きが近いほうの側を入れる（最後の区切りは null のまま）
export function fillSides(strokes, body, ref) {
  if (ref.right == null || ref.left == null) return strokes;
  const tilt = shoulderTilt(body);
  return strokes.map((s, n) => {
    const next = strokes[n + 1];
    if (s.side || !next) return s;
    const t = strokeTilt(tilt, s.frame, next.frame);
    if (t == null) return s;
    return { ...s, side: Math.abs(t - ref.right) <= Math.abs(t - ref.left) ? "right" : "left" };
  });
}

// 代表ストローク（PHASES 点）の肩の傾きの曲線
export const tiltCurve = (frames) => frames.map((f) => (f ? f[P.lShoulder].y - f[P.rShoulder].y : null));

// curve を何点ずらすと ref に最もよく重なるか（ストロークは繰り返すので、ずらしは一周まわる）
// 戻り値：ずらす点の数（0〜period−1）
export function bestShift(curve, ref) {
  const period = curve.length - 1; // 0% と 100% はほぼ同じ瞬間なので、最後の点は除いて一周とする
  const mean = (v) => { const ok = v.slice(0, period).filter((x) => x != null); return ok.reduce((a, b) => a + b, 0) / (ok.length || 1); };
  const mc = mean(curve);
  const mr = mean(ref);
  let best = 0;
  let bestScore = -Infinity;
  for (let s = 0; s < period; s++) {
    let score = 0;
    for (let i = 0; i < period; i++) {
      const c = curve[(i + s) % period];
      if (c != null && ref[i] != null) score += (c - mc) * (ref[i] - mr);
    }
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

// 位相を s 点ずらした配列（i 番目 ← 元の i+s 番目。最後の点は最初の点と同じにする）
export function shiftPhases(list, s) {
  if (!list || !s) return list;
  const period = list.length - 1;
  const out = list.slice(0, period).map((_, i) => list[(i + s) % period]);
  return [...out, out[0]];
}

// 統合の前に、各動画のストロークを用意する
//   手の高さで区切れなかった動画（後ろなど）は肩の傾きで区切り、漕ぐ側がわからないストロークは肩の傾きで決める
//   基準の肩の傾きは前の動画から取る（肩の高さの差は前からがよく見える。横からは奥の肩が隠れて不安定。
//   10/24 の動画：後ろと前の曲線の重なり 0.93／0.72、後ろと横は横どうしでも食い違った）。前がなければほかの動画から
// list：[{ name, body, strokes, fps }] → 戻り値：動画ごとのストローク（同じ並び）
export function prepareStrokes(list) {
  const strokes = list.map((d) => ((d.strokes ?? []).length > 1 || !d.body ? d.strokes ?? [] : tiltStrokes(d.body, d.fps)));
  const known = list.filter((d) => d.body && (d.strokes ?? []).some((s) => s.side));
  const base = known.some((d) => d.name === "front") ? known.filter((d) => d.name === "front") : known;
  const ref = sideTilt(base.map((d) => ({ body: d.body, strokes: d.strokes })));
  return list.map((d, k) => (d.body ? fillSides(strokes[k], d.body, ref) : strokes[k]));
}
