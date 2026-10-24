// 骨格推定（MediaPipe Pose Landmarker をブラウザ内で実行）
// - ライブラリとモデルはCDNから読み込む（動画は外部に送信しない）
// - 結果は画像上のピクセル座標 { x, y, v, src }。v＝信頼度（0〜1）、src: "est"＝推定値, "manual"＝手動修正
// 将来：オフライン利用のため、ライブラリとモデルをリポジトリ内に置く予定

import { frameCount, frameToTime } from "./frame-math.js";
import { backProfile } from "./spine.js";
import { decodeFrames } from "./decode.js";
import { HAND_POINTS } from "./hands.js";

const VERSION = "0.10.14";
const LIB = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
// 速さより細かさを優先し、精度重視のモデル（heavy）を使う。手は専用の推定（Hand Landmarker）でも測る
export const MODEL_NAME = "pose_landmarker_heavy (float16) + hand_landmarker";
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let landmarker = null;
let handLandmarker = null;
let clock = 0; // detectForVideo には増え続ける時刻が必要なため、解析をまたいで加算する

// GPUで作れなければCPUで作る
async function createWith(Task, fileset, options) {
  try {
    return await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: "GPU" } });
  } catch {
    return Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: "CPU" } });
  }
}

async function load() {
  if (landmarker) return;
  const { FilesetResolver, PoseLandmarker, HandLandmarker } = await import(`${LIB}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${LIB}/wasm`);
  landmarker = await createWith(PoseLandmarker, fileset, {
    baseOptions: { modelAssetPath: MODEL },
    runningMode: "VIDEO",
    numPoses: 1,
    outputSegmentationMasks: true, // 人物のシルエット（背中の輪郭から背骨の曲がりを推定するため）
  });
  handLandmarker = await createWith(HandLandmarker, fileset, {
    baseOptions: { modelAssetPath: HAND_MODEL },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.3, // パドルを握った手は見つけにくいので、低めにして拾う
    minHandPresenceConfidence: 0.3,
  });
}

function seekTo(video, time) {
  return new Promise((resolve) => {
    video.addEventListener("seeked", resolve, { once: true });
    video.currentTime = time;
  });
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

// 動画の全フレームを解析。戻り値：{ frames, world, spine, hands, method }（人が見つからないフレームは null）
//   frames：画像上のピクセル座標、world：MediaPipe の3D推定座標（腰の中心が原点、およそメートル）
//   spine：シルエットから測った背中の膨らみ（spine.js の backProfile。測れないフレームは null）
//   hands：手の専用推定。フレームごとに [{ s: 信頼度, p: [[x,y] 手首, 小指の付け根, 人差し指の付け根] }]（hands.js で使う）
//   method："順番に読む"（速い）または "頭出し"（順番に読めない動画のとき）
// file：動画ファイル（順番に読むために使う）
export async function analyzeVideo(video, file, fps, onProgress, isStopped) {
  await load();
  const total = frameCount(video.duration, fps);
  const w = video.videoWidth;
  const h = video.videoHeight;
  let out;
  const detect = (source) => {
    clock += 1000 / fps;
    addResult(out, landmarker.detectForVideo(source, clock), w, h);
    out.hands.push(handResult(handLandmarker.detectForVideo(source, clock), w, h));
    onProgress(Math.min(out.frames.length, total), total, out.method);
  };
  video.pause();

  out = { frames: [], world: [], spine: [], hands: [], method: "順番に読む" };
  const fast = await decodeFrames(file, detect, () => isStopped() || out.frames.length >= total).catch(() => false);
  if (!fast) {
    out = { frames: [], world: [], spine: [], hands: [], method: "頭出し" };
    for (let f = 0; f < total && !isStopped(); f++) {
      await seekTo(video, frameToTime(f, fps));
      detect(video);
    }
  }
  // フレーム数を動画の長さに合わせる（足りないところは「人が見つからない」扱い）
  for (const list of [out.frames, out.world, out.spine, out.hands]) {
    list.length = Math.min(list.length, total);
    while (list.length < total && !isStopped()) list.push(null);
  }
  return out;
}

// 手の専用推定の結果 → 保存する形（ピクセル座標、手首・小指の付け根・人差し指の付け根だけ）。見つからなければ null
function handResult(result, w, h) {
  if (!result.landmarks?.length) return null;
  return result.landmarks.map((hand, k) => ({
    s: round(result.handedness?.[k]?.[0]?.score ?? 0, 3),
    p: HAND_POINTS.map((i) => [round(hand[i].x * w, 1), round(hand[i].y * h, 1)]),
  }));
}

// 1フレーム分の結果を out に追加する
function addResult(out, result, w, h) {
  const person = result.landmarks[0];
  const person3d = result.worldLandmarks[0];
  out.frames.push(person
    ? person.map((p) => ({ x: round(p.x * w, 1), y: round(p.y * h, 1), v: round(p.visibility, 3), src: "est" }))
    : null);
  out.world.push(person3d
    ? person3d.map((p) => ({ x: round(p.x, 4), y: round(p.y, 4), z: round(p.z, 4), v: round(p.visibility, 3) }))
    : null);
  out.spine.push(person ? measureSpine(result.segmentationMasks?.[0], person) : null);
  result.segmentationMasks?.forEach((m) => m.close()); // マスクのメモリを解放
}

// シルエットから背中の膨らみを測る。マスクがない・読めないときは null
function measureSpine(mask, person) {
  if (!mask) return null;
  try {
    return backProfile(mask.getAsFloat32Array(), mask.width, mask.height, person);
  } catch {
    return null;
  }
}
