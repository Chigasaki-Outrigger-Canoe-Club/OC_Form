// 骨格推定（MediaPipe Pose Landmarker をブラウザ内で実行）
// - ライブラリとモデルはCDNから読み込む（動画は外部に送信しない）
// - 結果は画像上のピクセル座標 { x, y, v, src }。v＝信頼度（0〜1）、src: "est"＝推定値, "manual"＝手動修正
// 将来：オフライン利用のため、ライブラリとモデルをリポジトリ内に置く予定

import { frameCount, frameToTime } from "./frame-math.js";

const VERSION = "0.10.14";
const LIB = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
export const MODEL_NAME = "pose_landmarker_full (float16)";
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

let landmarker = null;
let clock = 0; // detectForVideo には増え続ける時刻が必要なため、解析をまたいで加算する

async function load() {
  if (landmarker) return landmarker;
  const { FilesetResolver, PoseLandmarker } = await import(`${LIB}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${LIB}/wasm`);
  const create = (delegate) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "VIDEO",
    numPoses: 1,
  });
  try {
    landmarker = await create("GPU");
  } catch {
    landmarker = await create("CPU");
  }
  return landmarker;
}

function seekTo(video, time) {
  return new Promise((resolve) => {
    video.addEventListener("seeked", resolve, { once: true });
    video.currentTime = time;
  });
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

// 動画の全フレームを解析。戻り値：{ frames, world }（人が見つからないフレームは null）
//   frames：画像上のピクセル座標、world：MediaPipe の3D推定座標（腰の中心が原点、およそメートル）
export async function analyzeVideo(video, fps, onProgress, isStopped) {
  const model = await load();
  const total = frameCount(video.duration, fps);
  const w = video.videoWidth;
  const h = video.videoHeight;
  const frames = [];
  const world = [];
  video.pause();

  for (let f = 0; f < total && !isStopped(); f++) {
    await seekTo(video, frameToTime(f, fps));
    clock += 1000 / fps;
    const result = model.detectForVideo(video, clock);
    const person = result.landmarks[0];
    const person3d = result.worldLandmarks[0];
    frames.push(person
      ? person.map((p) => ({ x: round(p.x * w, 1), y: round(p.y * h, 1), v: round(p.visibility, 3), src: "est" }))
      : null);
    world.push(person3d
      ? person3d.map((p) => ({ x: round(p.x, 4), y: round(p.y, 4), z: round(p.z, 4), v: round(p.visibility, 3) }))
      : null);
    onProgress(f + 1, total);
  }
  return { frames, world };
}
