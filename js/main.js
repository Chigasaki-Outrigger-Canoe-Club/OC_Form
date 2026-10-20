// 画面の操作（動画の読み込み・方向の切り替え・再生操作）
import { timeToFrame, frameToTime, frameCount, clampFrame, formatTime } from "./frame-math.js";

const el = (id) => document.getElementById(id);
const video = el("video");
const seek = el("seek");
const fpsInput = el("fps");

// 方向ごとに読み込んだ動画 { front: { url, name }, ... }
const files = {};
let currentView = "front";

const fps = () => Number(fpsInput.value) || 60;
const hasVideo = () => Boolean(files[currentView]);
const totalFrames = () => frameCount(video.duration || 0, fps());

// ---- 方向の切り替え ----
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => selectView(tab.dataset.view));
});

function selectView(view) {
  currentView = view;
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === view);
  });
  const file = files[view];
  if (file) video.src = file.url;
  else { video.removeAttribute("src"); video.load(); }
  el("fileName").textContent = file ? file.name : "未選択";
  el("emptyNote").hidden = Boolean(file);
  updateDisplay();
}

// ---- 動画の読み込み（PC内で処理。外部に送信しない） ----
el("fileInput").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (files[currentView]) URL.revokeObjectURL(files[currentView].url);
  files[currentView] = { url: URL.createObjectURL(file), name: file.name };
  document.querySelector(`.tab[data-view="${currentView}"]`).classList.add("loaded");
  event.target.value = "";
  selectView(currentView);
});

video.addEventListener("loadedmetadata", () => {
  el("resolution").textContent = `${video.videoWidth} × ${video.videoHeight}`;
  el("duration").textContent = formatTime(video.duration);
  updateDisplay();
});

// ---- 再生操作 ----
el("play").addEventListener("click", togglePlay);
el("prev").addEventListener("click", () => stepFrame(-1));
el("next").addEventListener("click", () => stepFrame(1));
el("speed").addEventListener("change", (e) => (video.playbackRate = Number(e.target.value)));
fpsInput.addEventListener("change", updateDisplay);
seek.addEventListener("input", () => goToFrame(Number(seek.value)));

function togglePlay() {
  if (!hasVideo()) return;
  video.paused ? video.play() : video.pause();
}

function stepFrame(delta) {
  if (!hasVideo()) return;
  video.pause();
  goToFrame(timeToFrame(video.currentTime, fps()) + delta);
}

function goToFrame(frame) {
  video.currentTime = frameToTime(clampFrame(frame, totalFrames()), fps());
}

// キーボード：スペース＝再生/停止、←→＝コマ送り
document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT"].includes(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.code === "ArrowLeft") stepFrame(-1);
  if (e.code === "ArrowRight") stepFrame(1);
});

// ---- 表示の更新 ----
video.addEventListener("play", tick);
video.addEventListener("pause", updateDisplay);
video.addEventListener("seeked", updateDisplay);

function tick() {
  updateDisplay();
  if (!video.paused) requestAnimationFrame(tick);
}

function updateDisplay() {
  const loaded = hasVideo() && video.readyState > 0;
  const frame = loaded ? timeToFrame(video.currentTime, fps()) : 0;
  seek.max = loaded ? totalFrames() - 1 : 0;
  seek.value = frame;
  el("time").textContent = loaded ? formatTime(video.currentTime) : "--";
  el("frame").textContent = loaded ? `${frame} / ${totalFrames() - 1}` : "--";
  el("play").textContent = video.paused ? "▶ 再生" : "⏸ 停止";
  if (!loaded) {
    el("resolution").textContent = "--";
    el("duration").textContent = "--";
  }
}

selectView("front");
