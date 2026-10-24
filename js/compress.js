// 動画を小さくする（GitHub に保存するため）
// 元の動画（1本 60〜70MB）をそのまま送ると、GitHub の容量（無料で約1GBまでが目安）がすぐにいっぱいになる。
// そこでブラウザの中で、長い辺 LONG_SIDE px・ビットレート BITRATE の H.264（MP4）に作り直す（音は入れない）。
// 40秒の動画で約 5〜8MB。スマホでもそのまま再生できる形式。
// 使えないとき（MP4以外・WebCodecs非対応など）は null を返す

import { decodeFrames } from "./decode.js";

const MUXER = "https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/+esm";
const LONG_SIDE = 960;
const BITRATE = 1_200_000; // 1.2 Mbps
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// file：元の動画、size：{ width, height }（元の大きさ）、fps、onProgress(割合 0〜1)
export async function compressVideo(file, size, fps, onProgress = () => {}) {
  if (!("VideoEncoder" in window)) return null;
  const k = Math.min(1, LONG_SIDE / Math.max(size.width, size.height));
  const width = even(size.width * k);
  const height = even(size.height * k);
  // H.264 Baseline（どの端末でも再生できる）を優先。使えないブラウザでは VP9
  const choices = [{ codec: "avc1.42001f", mux: "avc" }, { codec: "vp09.00.10.08", mux: "vp9" }];
  let choice = null;
  for (const c of choices) {
    if ((await VideoEncoder.isConfigSupported({ codec: c.codec, width, height, bitrate: BITRATE, framerate: fps })).supported) { choice = c; break; }
  }
  if (!choice) return null;
  const config = { codec: choice.codec, width, height, bitrate: BITRATE, framerate: fps };

  const { Muxer, ArrayBufferTarget } = await import(MUXER);
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: choice.mux, width, height, frameRate: fps }, fastStart: "in-memory" });
  let failed = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (failed = e) });
  encoder.configure(config);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const total = Math.max(1, Math.round((size.duration ?? 1) * fps));
  let n = 0;

  const ok = await decodeFrames(file, async (frame) => {
    if (failed) throw failed;
    ctx.drawImage(frame, 0, 0, width, height);
    const small = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
    encoder.encode(small, { keyFrame: n % Math.round(fps * 2) === 0 }); // 2秒ごとに区切りのコマ（途中から再生しやすく）
    small.close();
    n++;
    onProgress(Math.min(1, n / total));
    while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5)); // 書き出しが追いつくまで待つ
  }, () => false).catch(() => false);
  if (!ok || failed) { if (encoder.state !== "closed") encoder.close(); return null; }
  await encoder.flush();
  encoder.close();
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}
