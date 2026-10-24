// 動画を頭から順番に1コマずつ取り出す（WebCodecs）
// 1コマずつ頭出し（seek）すると、そのたびに直前の区切りのコマから読み直すため遅い。
// 順番に読めば、各コマを1回読むだけで済む。
// 使えないとき（MP4以外・WebCodecs非対応・回転情報つき・この端末で読めない形式）は false を返す → 呼び出し側は頭出しで解析する

const MP4BOX = "https://cdn.jsdelivr.net/npm/mp4box@0.5.2/+esm";
const IDENTITY = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824]; // 回転なしの変換行列
const QUEUE = 6; // 同時に持つコマの上限（メモリを使いすぎないため）

const wait = () => new Promise((resolve) => setTimeout(resolve, 1));

// MP4を読み、映像トラックの情報と全サンプル（圧縮されたコマ）を返す。MP4でなければ null
async function readTrack(file) {
  const lib = await import(MP4BOX);
  const MP4Box = lib.default ?? lib;
  const mp4 = MP4Box.createFile();
  let track = null;
  const samples = [];
  mp4.onReady = (info) => {
    track = info.videoTracks[0];
    if (!track) return;
    mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
    mp4.start();
  };
  mp4.onSamples = (id, user, list) => samples.push(...list);
  const buffer = await file.arrayBuffer();
  buffer.fileStart = 0;
  mp4.appendBuffer(buffer);
  mp4.flush();
  if (!track) return null;
  return { track, samples, description: codecDescription(MP4Box, mp4.getTrackById(track.id)) };
}

// デコーダの設定に必要な、圧縮形式ごとの情報（avcC・hvcC など。先頭8バイトの箱の見出しは除く）
function codecDescription(MP4Box, trak) {
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box) continue;
    const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer, 8);
  }
  return undefined;
}

// onFrame(frame)：コマを表示順に1つずつ渡す（frame は VideoFrame。呼び出し後に閉じる。Promise を返せば終わるまで待つ）
// 戻り値：最後まで読めたら true、この方法が使えなければ false
export async function decodeFrames(file, onFrame, isStopped) {
  if (!("VideoDecoder" in window) || !file || !/\.(mp4|mov|m4v)$/i.test(file.name)) return false;
  const mp4 = await readTrack(file);
  if (!mp4 || mp4.track.matrix?.some((n, i) => n !== IDENTITY[i])) return false;

  const config = { codec: mp4.track.codec, codedWidth: mp4.track.video.width, codedHeight: mp4.track.video.height, description: mp4.description };
  if (!(await VideoDecoder.isConfigSupported(config)).supported) return false;

  const ready = []; // デコード済みで、まだ解析していないコマ
  let failed = null;
  const decoder = new VideoDecoder({ output: (frame) => ready.push(frame), error: (e) => (failed = e) });
  decoder.configure(config);

  let next = 0; // 次にデコーダへ渡すサンプル
  let flushing = null;
  let done = false; // 全コマがデコーダから出てきた
  try {
    while (!isStopped()) {
      if (failed) throw failed;
      while (next < mp4.samples.length && ready.length + decoder.decodeQueueSize < QUEUE) {
        const s = mp4.samples[next++];
        decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? "key" : "delta", timestamp: (s.cts * 1e6) / s.timescale, duration: (s.duration * 1e6) / s.timescale, data: s.data }));
      }
      if (next === mp4.samples.length && !flushing) flushing = decoder.flush().then(() => (done = true), () => {});
      if (ready.length) {
        const frame = ready.shift();
        await onFrame(frame); // onFrame が待つ必要のある処理（動画の書き出しなど）なら終わるまで待つ
        frame.close();
      } else if (done) {
        return true;
      }
      await wait(); // 画面（進み具合の表示）を更新するため、1コマごとに一息つく
    }
    return true;
  } finally {
    ready.forEach((f) => f.close());
    if (decoder.state !== "closed") decoder.close();
  }
}
