// 画面の操作：各機能（計算・描画）をつなぐ
import { timeToFrame, frameToTime, frameCount, clampFrame, formatTime } from "./frame-math.js";
import { readVideoInfo } from "./mp4-info.js";
import { analyzeVideo, MODEL_NAME } from "./pose.js";
import { ANGLES, TRUNK_LABEL, computeAngles } from "./angles.js";
import { detectStrokes, strokeIndexAt } from "./strokes.js";
import { drawSkeleton, toVideoPoint, nearestJoint } from "./overlay.js";
import { drawChart, chartFrameAt } from "./chart.js";
import { buildCSV, buildJSON } from "./export.js";

const el = (id) => document.getElementById(id);
const video = el("video");
const overlay = el("overlay");
const chart = el("chart");
const seek = el("seek");
const fpsInput = el("fps");

const VIEW_LABELS = { front: "前", left: "左", right: "右", back: "後ろ" };
const ANGLE_LABELS = { ...Object.fromEntries(Object.entries(ANGLES).map(([k, a]) => [k, a.label])), trunk: TRUNK_LABEL };

// 方向ごとのデータ { left: { url, name, fps, fpsSource, pose, strokes }, ... }
const views = {};
let currentView = "front";
let stopRequested = false;
let analyzing = false;

const data = () => views[currentView];
const fps = () => Number(fpsInput.value) || 60;
const totalFrames = () => frameCount(video.duration || 0, fps());
const currentFrame = () => clampFrame(timeToFrame(video.currentTime, fps()), totalFrames());
const loaded = () => Boolean(data()) && video.readyState > 0;

// ================= 方向の切り替え =================
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => selectView(tab.dataset.view));
});

function selectView(view) {
  if (analyzing) return;
  currentView = view;
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === view);
    tab.classList.toggle("loaded", Boolean(views[tab.dataset.view]));
  });
  const d = data();
  if (d) {
    video.src = d.url;
    fpsInput.value = d.fps;
  } else {
    video.removeAttribute("src");
    video.load();
  }
  el("fileName").textContent = d ? d.name : "未選択";
  el("fpsSource").textContent = d ? d.fpsSource : "";
  el("emptyNote").hidden = Boolean(d);
  renderStrokes();
  updateDisplay();
}

// ================= 動画の読み込み（PC内で処理） =================
el("fileInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (views[currentView]) URL.revokeObjectURL(views[currentView].url);

  // fpsは動画のヘッダから読む。読めなければ手入力
  const info = readVideoInfo(new DataView(await file.arrayBuffer()));
  views[currentView] = {
    url: URL.createObjectURL(file),
    name: file.name,
    fps: info ? info.fps : fps(),
    fpsSource: info ? "（動画から取得）" : "（読み取れないため手入力してください）",
    pose: null,
    strokes: [],
  };
  el("progress").textContent = "未解析";
  selectView(currentView);
});

video.addEventListener("loadedmetadata", () => {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  el("stage").style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`; // 縦長動画にも合わせる
  updateDisplay();
});

video.addEventListener("error", () => {
  if (data()) el("fileName").textContent = `${data().name}：このブラウザでは再生できない形式です`;
});

fpsInput.addEventListener("change", () => {
  if (data()) { data().fps = fps(); data().fpsSource = "（手入力）"; }
  el("fpsSource").textContent = data()?.fpsSource ?? "";
  updateDisplay();
});

// ================= 再生操作 =================
el("play").addEventListener("click", togglePlay);
el("prev").addEventListener("click", () => stepFrame(-1));
el("next").addEventListener("click", () => stepFrame(1));
el("speed").addEventListener("change", (e) => (video.playbackRate = Number(e.target.value)));
seek.addEventListener("input", () => goToFrame(Number(seek.value)));

function togglePlay() {
  if (!loaded() || analyzing) return;
  video.paused ? video.play() : video.pause();
}

function stepFrame(delta) {
  if (!loaded() || analyzing) return;
  video.pause();
  goToFrame(currentFrame() + delta);
}

function goToFrame(frame) {
  video.currentTime = frameToTime(clampFrame(frame, totalFrames()), fps());
}

document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT"].includes(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.code === "ArrowLeft") stepFrame(-1);
  if (e.code === "ArrowRight") stepFrame(1);
});

video.addEventListener("play", tick);
video.addEventListener("pause", updateDisplay);
video.addEventListener("seeked", updateDisplay);

function tick() {
  updateDisplay();
  if (!video.paused) requestAnimationFrame(tick);
}

// ================= 選手情報（ブラウザ内に保存） =================
const ATHLETE_KEY = "oc-form-athlete";
const athleteInputs = ["height", "weight", "paddle"];

function loadAthlete() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(ATHLETE_KEY)) || {}; } catch { /* 保存なし */ }
  athleteInputs.forEach((id) => (el(id).value = saved[id] ?? ""));
  showPaddleCm();
}

function athlete() {
  return {
    heightCm: Number(el("height").value) || null,
    weightKg: Number(el("weight").value) || null,
    paddleInch: Number(el("paddle").value) || null,
    paddleCm: Number(el("paddle").value) ? Math.round(Number(el("paddle").value) * 2.54 * 10) / 10 : null,
  };
}

function showPaddleCm() {
  const cm = athlete().paddleCm;
  el("paddleCm").textContent = cm ? `（${cm} cm）` : "";
}

athleteInputs.forEach((id) => el(id).addEventListener("change", () => {
  const values = Object.fromEntries(athleteInputs.map((k) => [k, el(k).value]));
  try { localStorage.setItem(ATHLETE_KEY, JSON.stringify(values)); } catch { /* 保存できない環境 */ }
  showPaddleCm();
}));

// ================= 骨格推定 =================
el("analyze").addEventListener("click", async () => {
  if (!loaded() || analyzing) return;
  const d = data();
  analyzing = true;
  stopRequested = false;
  setAnalyzing(true);
  el("progress").textContent = "ライブラリとモデルを読み込み中…";
  const started = performance.now();
  try {
    const frames = await analyzeVideo(video, fps(), (done, total) => {
      el("progress").textContent = `解析中… ${done} / ${total} フレーム`;
    }, () => stopRequested);
    const found = frames.filter(Boolean).length;
    const seconds = ((performance.now() - started) / 1000).toFixed(0);
    if (stopRequested) {
      el("progress").textContent = "中止しました（結果は保存していません）";
    } else {
      d.pose = frames;
      d.strokes = detectStrokes(frames, fps());
      el("progress").textContent = `完了：${frames.length} フレーム中 ${found} フレームで人を検出（${seconds} 秒）`;
    }
  } catch (err) {
    el("progress").textContent = `解析に失敗しました：${err.message}`;
  }
  analyzing = false;
  setAnalyzing(false);
  renderStrokes();
  updateDisplay();
});

el("stop").addEventListener("click", () => (stopRequested = true));
el("showSkeleton").addEventListener("change", updateDisplay);

function setAnalyzing(on) {
  el("analyze").disabled = on;
  el("stop").disabled = !on;
}

// ---- 関節のドラッグ修正（停止中のみ） ----
let dragging = null;

overlay.addEventListener("pointerdown", (e) => {
  const lm = data()?.pose?.[currentFrame()];
  if (!lm || !video.paused || analyzing) return;
  const joint = nearestJoint(lm, toVideoPoint(overlay, e));
  if (joint == null) return;
  dragging = joint;
  overlay.setPointerCapture(e.pointerId);
});

overlay.addEventListener("pointermove", (e) => {
  if (dragging == null) return;
  const lm = data().pose[currentFrame()];
  const p = toVideoPoint(overlay, e);
  lm[dragging] = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, v: 1, src: "manual" };
  updateDisplay();
});

overlay.addEventListener("pointerup", () => (dragging = null));

// ================= ストローク =================
el("detect").addEventListener("click", () => {
  const d = data();
  if (!d?.pose) return alert("先に骨格推定を行ってください");
  d.strokes = detectStrokes(d.pose, fps());
  renderStrokes();
  updateDisplay();
});

el("addStroke").addEventListener("click", () => {
  const d = data();
  if (!loaded()) return;
  const frame = currentFrame();
  if (d.strokes.some((s) => s.frame === frame)) return;
  d.strokes.push({ frame, side: null, src: "manual" });
  d.strokes.sort((a, b) => a.frame - b.frame);
  renderStrokes();
  updateDisplay();
});

function renderStrokes() {
  const strokes = data()?.strokes ?? [];
  const body = el("strokeList");
  body.innerHTML = "";
  el("strokeCount").textContent = strokes.length > 1 ? `（${strokes.length - 1} ストローク）` : "";

  strokes.forEach((s, n) => {
    const last = n === strokes.length - 1;
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${last ? "終端" : n + 1}</td>
      <td><button class="link">${formatTime(s.frame / fps())}</button></td>
      <td>${last ? "" : `<select class="btn small">
        <option value="">不明</option>
        <option value="left" ${s.side === "left" ? "selected" : ""}>左</option>
        <option value="right" ${s.side === "right" ? "selected" : ""}>右</option>
      </select>`} ${s.src === "manual" ? '<span class="muted">修正</span>' : ""}</td>
      <td><button class="btn small">削除</button></td>`;

    row.querySelector(".link").addEventListener("click", () => { video.pause(); goToFrame(s.frame); });
    row.querySelector("select")?.addEventListener("change", (e) => {
      s.side = e.target.value || null;
      s.src = "manual";
      renderStrokes();
    });
    row.querySelector("td:last-child button").addEventListener("click", () => {
      strokes.splice(n, 1);
      renderStrokes();
      updateDisplay();
    });
    body.appendChild(row);
  });
}

// ================= グラフ =================
Object.entries(ANGLE_LABELS).forEach(([key, label]) => {
  el("angleSelect").add(new Option(label, key));
});
el("angleSelect").addEventListener("change", updateDisplay);
window.addEventListener("resize", updateDisplay);

chart.addEventListener("click", (e) => {
  if (!data()?.pose) return;
  video.pause();
  goToFrame(chartFrameAt(chart, e, data().pose.length));
});

// ================= 書き出し・読み込み =================
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

const baseName = () => data().name.replace(/\.[^.]+$/, "");

el("exportCSV").addEventListener("click", () => {
  const d = data();
  if (!d?.pose) return alert("骨格推定の結果がありません");
  download(`${baseName()}_pose.csv`, buildCSV(d.pose, fps(), d.strokes), "text/csv");
});

el("exportJSON").addEventListener("click", () => {
  const d = data();
  if (!d?.pose) return alert("骨格推定の結果がありません");
  const meta = {
    view: currentView,
    viewLabel: VIEW_LABELS[currentView],
    video: { name: d.name, fps: fps(), fpsSource: d.fpsSource, width: video.videoWidth, height: video.videoHeight, duration: video.duration },
    model: MODEL_NAME,
    athlete: athlete(),
  };
  download(`${baseName()}_pose.json`, JSON.stringify(buildJSON(meta, d.pose, d.strokes)), "application/json");
});

el("importJSON").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const d = data();
  if (!loaded()) return alert("先に同じ動画を選んでください");
  try {
    const json = JSON.parse(await file.text());
    if (json.format !== "oc-form-analysis") throw new Error("このシステムのJSONではありません");
    if (json.video.name !== d.name && !confirm(`動画名が違います（${json.video.name}）。読み込みますか？`)) return;
    d.pose = json.frames;
    d.strokes = json.strokes;
    d.fps = json.video.fps;
    fpsInput.value = d.fps;
    el("progress").textContent = `JSONから読み込みました（${json.frames.length} フレーム）`;
    renderStrokes();
    updateDisplay();
  } catch (err) {
    alert(`読み込めませんでした：${err.message}`);
  }
});

// ================= 表示の更新 =================
function updateDisplay() {
  const ok = loaded();
  const frame = ok ? currentFrame() : 0;
  const d = data();
  const lm = d?.pose?.[frame] ?? null;

  seek.max = ok ? totalFrames() - 1 : 0;
  seek.value = frame;
  el("time").textContent = ok ? formatTime(video.currentTime) : "--";
  el("frame").textContent = ok ? `${frame} / ${totalFrames() - 1}` : "--";
  el("duration").textContent = ok ? formatTime(video.duration) : "--";
  el("resolution").textContent = ok ? `${video.videoWidth} × ${video.videoHeight}` : "--";
  el("play").textContent = video.paused ? "▶ 再生" : "⏸ 停止";

  // 骨格
  drawSkeleton(overlay, ok && el("showSkeleton").checked ? lm : null);

  // 現在フレームの角度
  const angles = computeAngles(lm);
  const n = d ? strokeIndexAt(frame, d.strokes) : -1;
  const side = n >= 0 ? { left: "左", right: "右" }[d.strokes[n].side] ?? "不明" : "--";
  el("currentAngles").innerHTML =
    `<dt>ストローク</dt><dd>${n >= 0 ? `${n + 1}（${side}）` : "--"}</dd>` +
    Object.entries(ANGLE_LABELS)
      .map(([k, label]) => `<dt>${label}</dt><dd>${angles[k] == null ? "--" : `${angles[k].toFixed(1)}°`}</dd>`)
      .join("");

  // グラフ（再生中は負荷を下げるため停止時のみ描く）
  if (video.paused) {
    const key = el("angleSelect").value;
    const values = d?.pose ? d.pose.map((f) => computeAngles(f)[key]) : [];
    drawChart(chart, values, frame, d?.strokes ?? []);
  }
}

loadAthlete();
selectView("left");
