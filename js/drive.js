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

// ストロークの区切りを「キャッチ（力を入れ始める位置）」に合わせる
// 自動検出の区切りは「手が最も高い時点」なので、各ストロークの中でドライブが始まる位置へ移す。
// 手で設定した区切り（src: "manual"）はそのまま。body がなければ何もしない。
export function refineToCatch(strokes, body) {
  if (!body) return strokes;
  const out = strokes.map((s) => ({ ...s }));
  out.forEach((s, n) => {
    const next = out[n + 1];
    if (!next || s.src === "manual" || !s.side) return;
    const drive = detectDrive(body.slice(s.frame, next.frame), s.side);
    if (drive) s.frame += drive.start;
  });
  return dropShortLast(out);
}

// 最後のストロークが短すぎる（途中で動画が終わった）ときは、平均に混ぜないよう終端にする
// 目安：ほかのストロークの中央値の 80% 未満
function dropShortLast(strokes) {
  if (strokes.length < 4) return strokes;
  const lengths = strokes.slice(0, -2).map((s, n) => strokes[n + 1].frame - s.frame).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)];
  const n = strokes.length - 2;
  if (strokes[n + 1].frame - strokes[n].frame >= median * 0.8) return strokes;
  return [...strokes.slice(0, n), { ...strokes[n], side: null }];
}

// 力が抜けた位置（推定）：キャッチから次のキャッチまでのドライブの終わりのフレーム
export function releaseFrame(strokes, n, body) {
  const s = strokes[n];
  const next = strokes[n + 1];
  if (!body || !next || !s.side) return null;
  const drive = detectDrive(body.slice(s.frame, next.frame), s.side);
  return drive ? s.frame + drive.end : null;
}
