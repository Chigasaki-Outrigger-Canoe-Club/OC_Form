// 骨格の点のぶれを取る（フレームの並びに沿って、点ごと・軸ごとに）
//
// 骨格推定はフレームごとに独立に推定するため、点が細かくぶれ、ときどき大きく外れる。
// 体の動きはなめらかなので、次の3段で「きれいに動く推定値」にする：
//   1. 信用しない値を外す：信頼度が低い（0.5未満）点、前後の値の中央値から大きく外れた点（外れ値）
//   2. 外した所を、前後の信用できる値から直線で補間する
//   3. 前後数フレームの重み付き平均でならす（ガウス重み。約0.05秒）
// 人が直した点（src: "manual"）は外さず、ならすときも重く使う

const AXES = ["x", "y", "z"];
const MIN_V = 0.5;           // これより低い信頼度は信用しない
const OUTLIER_WINDOW = 4;    // 外れ値を調べる範囲（前後のフレーム数）
const OUTLIER_K = 3;         // 中央値からのずれが「ばらつき（MAD）× k」を超えたら外れ値
const MIN_SPREAD = 0.01;     // ばらつきの下限（m）。止まっている点の小さな揺れを外れ値にしないため
const MAX_GAP_SEC = 0.5;     // これより長く信用できない区間は補間しない（元の値のまま）
const SIGMA_SEC = 0.05;      // ならす幅（秒）

const median = (list) => {
  const v = [...list].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};

// 1本の値の並び（null＝なし）から外れ値を外す。keep[i]＝true の値は外さない
export function dropOutliers(values, keep = []) {
  return values.map((v, i) => {
    if (v == null || keep[i]) return v;
    const near = values.slice(Math.max(0, i - OUTLIER_WINDOW), i + OUTLIER_WINDOW + 1).filter((x) => x != null);
    if (near.length < 3) return v;
    const m = median(near);
    const spread = Math.max(1.4826 * median(near.map((x) => Math.abs(x - m))), MIN_SPREAD);
    return Math.abs(v - m) > OUTLIER_K * spread ? null : v;
  });
}

// null の所を、前後の値から直線で補間する（maxGap フレームより長い穴は fallback の値）
export function fillGaps(values, maxGap, fallback) {
  const out = [...values];
  let i = 0;
  while (i < out.length) {
    if (out[i] != null) { i++; continue; }
    let j = i;
    while (j < out.length && out[j] == null) j++;
    const a = out[i - 1];
    const b = out[j];
    for (let k = i; k < j; k++) {
      if (j - i > maxGap || (a == null && b == null)) out[k] = fallback[k];
      else if (a == null) out[k] = b;
      else if (b == null) out[k] = a;
      else out[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }
  return out;
}

// ガウス重みでならす。weight[i]＝その値の重み（人が直した点は重く）
export function gaussian(values, sigma, weight = []) {
  const r = Math.ceil(sigma * 2.5);
  return values.map((v, i) => {
    if (v == null) return v;
    let sum = 0;
    let total = 0;
    for (let k = -r; k <= r; k++) {
      const x = values[i + k];
      if (x == null) continue;
      const w = Math.exp(-(k * k) / (2 * sigma * sigma)) * (weight[i + k] ?? 1);
      sum += x * w;
      total += w;
    }
    return sum / total;
  });
}

// 全フレームの骨格（world、またはその並び）のぶれを取った新しい配列を返す
// frames：フレームごとの点の配列（null＝人が見つからない）、fps：1秒のフレーム数
export function smoothFrames(frames, fps) {
  const n = frames.findIndex(Boolean);
  if (n < 0) return frames;
  const joints = frames[n].length;
  const out = frames.map((f) => (f ? f.map((p) => ({ ...p })) : null));
  const sigma = Math.max(SIGMA_SEC * fps, 0.5);
  const maxGap = Math.round(MAX_GAP_SEC * fps);
  for (let j = 0; j < joints; j++) {
    const manual = frames.map((f) => f?.[j].src === "manual");
    const trusted = frames.map((f, i) => Boolean(f) && (manual[i] || f[j].v >= MIN_V));
    const weight = manual.map((m) => (m ? 10 : 1));
    for (const a of AXES) {
      const raw = frames.map((f) => (f ? f[j][a] : null));
      const kept = dropOutliers(raw.map((v, i) => (trusted[i] ? v : null)), manual);
      const filled = fillGaps(kept, maxGap, raw);
      const smooth = gaussian(filled.map((v, i) => (frames[i] ? v : null)), sigma, weight);
      smooth.forEach((v, i) => out[i] && !manual[i] && (out[i][j][a] = v)); // 人が直した点はそのまま
    }
  }
  return out;
}
