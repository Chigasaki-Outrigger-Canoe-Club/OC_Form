// 力を入れている区間（引き＝ドライブ）の推定
//
// エルゴではケーブルを後ろへ引いているときだけ力がかかる。そこで、
// 「下の手（漕ぐ側の手）が後ろ（−Z）へ動いている区間」を力を入れている区間とみなす。
//   - 速度は前後1フレームの差。ノイズを抑えるため前後2フレームで平均する
//   - 最も速く後ろへ動く速さの 30% 以上で後ろへ動いているところをドライブ候補とする
//   - 1ストロークのドライブは1回なので、候補のうち最も長い連続区間だけを残す
//     （ドライブ前の手の小さなぶれ＝力を抜いてパドルを前に出す動きは、ドライブに含めない）
// これは手の動きからの推定で、力の実測ではない（PM5のデータと合わせるのは MVP 3）。

import { P } from "./angles.js";

const RATIO = 0.3;

// frames：1ストローク分の3D骨格（選手基準）、side：漕ぐ側
// 戻り値：{ mask: [true/false...], start, end, ratio }（判定できないときは null）
export function detectDrive(frames, side) {
  const wrist = side === "left" ? P.lWrist : P.rWrist;
  const z = frames.map((f) => (f ? f[wrist].z : null));
  const v = z.map((_, i) => (z[i - 1] != null && z[i + 1] != null ? (z[i + 1] - z[i - 1]) / 2 : null));
  const smooth = v.map((_, i) => {
    const near = v.slice(Math.max(0, i - 2), i + 3).filter((x) => x != null);
    return near.length ? near.reduce((a, b) => a + b, 0) / near.length : null;
  });
  const fastest = Math.min(...smooth.filter((x) => x != null));
  if (!(fastest < 0)) return null;

  // 最も長い連続区間
  let best = { start: -1, end: -1 };
  let start = -1;
  smooth.forEach((s, i) => {
    const pulling = s != null && s <= fastest * RATIO;
    if (pulling && start < 0) start = i;
    if ((!pulling || i === smooth.length - 1) && start >= 0) {
      const end = pulling ? i : i - 1;
      if (end - start > best.end - best.start) best = { start, end };
      start = -1;
    }
  });
  if (best.start < 0) return null;
  const mask = frames.map((_, i) => i >= best.start && i <= best.end);
  return { mask, start: best.start, end: best.end, ratio: (best.end - best.start + 1) / frames.length };
}
