// 時間とフレーム番号の変換（表示処理から分離した計算のみ）
// 注意：ブラウザは動画の正確なフレーム番号を提供しない。
// ここでのフレーム番号は「入力したfps」から計算した推定値。

// 秒 → フレーム番号（0始まり）
export function timeToFrame(seconds, fps) {
  return Math.floor(seconds * fps + 1e-6);
}

// フレーム番号 → 秒（フレームの中央を指す。境界で前のフレームに落ちるのを防ぐ）
export function frameToTime(frame, fps) {
  return (frame + 0.5) / fps;
}

// 動画全体のフレーム数
export function frameCount(duration, fps) {
  return Math.max(1, Math.round(duration * fps));
}

// フレーム番号を 0〜(総数-1) に収める
export function clampFrame(frame, total) {
  return Math.min(Math.max(frame, 0), total - 1);
}

// 秒 → "mm:ss.mmm"
export function formatTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(rest).padStart(3, "0")}`;
}
