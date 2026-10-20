// 画面の操作：各機能（計算・描画）をつなぐ
import { timeToFrame, frameToTime, frameCount, clampFrame, formatTime } from "./frame-math.js";
import { readVideoInfo } from "./mp4-info.js";
import { analyzeVideo, MODEL_NAME } from "./pose.js";
import { ANGLES, TRUNK_LABEL, computeAngles, P } from "./angles.js";
import { detectStrokes, strokeIndexAt } from "./strokes.js";
import { drawSkeleton, toVideoPoint, nearestJoint } from "./overlay.js";
import { drawChart, chartFrameAt } from "./chart.js";
import { buildCSV, buildJSON } from "./export.js";
import { toBodyFrame, estimatePaddle } from "./body3d.js";
import { setupView3d, setFixedView, updateView3d } from "./view3d.js";
import { COLOR } from "./overlay.js";
import * as athletes from "./athletes.js";

const el = (id) => document.getElementById(id);
const video = el("video");
const overlay = el("overlay");
const chart = el("chart");
const seek = el("seek");
const fpsInput = el("fps");

const VIEW_LABELS = { front: "前", left: "左", right: "右", back: "後ろ" };
const ANGLE_LABELS = { ...Object.fromEntries(Object.entries(ANGLES).map(([k, a]) => [k, a.label])), trunk: TRUNK_LABEL };

// 方向ごとのデータ { left: { url, name, fps, fpsSource, pose, world, body, strokes }, ... }
// pose＝2D画像座標、world＝MediaPipeの3D推定、body＝worldを選手基準に変換した座標
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
  showStatus(d ? "読み込み中…" : "「動画を選択」から、この方向の動画を読み込んでください");
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
    codec: info?.codec ?? null,
    pose: null,
    world: null,
    body: null,
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

// ---- 動画の状態表示（黒い画面のときに理由を出す） ----
const HEVC = ["hvc1", "hev1"];
const CANNOT_PLAY = "この動画はこのブラウザで表示できません。";
const HEVC_HELP = "スマホの動画はHEVC（H.265）形式です。Chrome・Edgeで表示できない場合は、パソコンにHEVC対応がない可能性があります。カメラ設定をH.264（互換性優先）にして撮影するか、H.264に変換してください。";

function showStatus(text) {
  el("videoStatus").textContent = text;
  el("videoStatus").hidden = !text;
}

function playbackProblem() {
  const isHevc = HEVC.includes(data()?.codec);
  return CANNOT_PLAY + (isHevc ? HEVC_HELP : "MP4（H.264）形式の動画を使ってください。");
}

video.addEventListener("loadeddata", () => {
  showStatus(video.videoWidth ? "" : playbackProblem());
});

video.addEventListener("error", () => {
  if (data()) showStatus(playbackProblem());
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

// ================= 選手情報（選手ごとにブラウザ内に保存） =================
const athleteInputs = ["height", "weight", "paddle", "bladeLength", "bladeWidth"];
// 未入力時の標準値（パドル全長 inch、ブレード cm）
const DEFAULTS = { paddle: 50, bladeLength: 48, bladeWidth: 25 };

let store = athletes.loadStore(localStorage);
if (store.list.length) athletes.saveStore(localStorage, store); // 引き継いだ保存をすぐ確定する

function inputValues() {
  return Object.fromEntries(athleteInputs.map((id) => [id, el(id).value]));
}

function saveAthletes(next) {
  store = next;
  const ok = athletes.saveStore(localStorage, store);
  el("athleteNote").textContent = ok ? "" : "このブラウザでは保存できません（書き出しでバックアップしてください）";
  renderAthletes();
}

// 選手の一覧と入力欄を表示する
function renderAthletes() {
  const select = el("athleteSelect");
  select.innerHTML = "";
  if (!store.list.length) select.add(new Option("（選手を追加してください）", ""));
  store.list.forEach((a) => select.add(new Option(a.name, a.id, false, a.id === store.current)));
  const values = athletes.currentAthlete(store)?.values ?? {};
  athleteInputs.forEach((id) => (el(id).value = values[id] ?? ""));
  Object.entries(DEFAULTS).forEach(([id, v]) => (el(id).placeholder = `標準 ${v}`));
  showPaddleCm();
  updateDisplay();
}

el("athleteSelect").addEventListener("change", (e) => saveAthletes({ ...store, current: e.target.value }));

el("addAthlete").addEventListener("click", () => {
  const name = prompt("選手の名前");
  // 最初の1人は今の入力値を引き継ぐ。2人目以降は空欄から
  if (name) saveAthletes(athletes.addAthlete(store, name, store.list.length ? {} : inputValues()));
});

el("renameAthlete").addEventListener("click", () => {
  const a = athletes.currentAthlete(store);
  const name = a && prompt("新しい名前", a.name);
  if (name) saveAthletes(athletes.renameAthlete(store, a.id, name));
});

el("removeAthlete").addEventListener("click", () => {
  const a = athletes.currentAthlete(store);
  if (a && confirm(`${a.name} を削除しますか？（元に戻せません）`)) saveAthletes(athletes.removeAthlete(store, a.id));
});

el("exportAthletes").addEventListener("click", () => {
  download("oc-form_athletes.json", JSON.stringify(athletes.buildBackup(store), null, 2), "application/json");
});

el("importAthletes").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const next = athletes.parseBackup(await file.text());
    if (confirm(`${next.list.length} 人の選手データで置き換えますか？`)) saveAthletes(next);
  } catch (err) {
    alert(`読み込めませんでした：${err.message}`);
  }
});

function athlete() {
  return {
    name: athletes.currentAthlete(store)?.name ?? null,
    heightCm: Number(el("height").value) || null,
    weightKg: Number(el("weight").value) || null,
    paddleInch: Number(el("paddle").value) || null,
    paddleCm: Number(el("paddle").value) ? Math.round(Number(el("paddle").value) * 2.54 * 10) / 10 : null,
    bladeLengthCm: Number(el("bladeLength").value) || null,
    bladeWidthCm: Number(el("bladeWidth").value) || null,
  };
}

// 3D表示用のパドル寸法（m）。未入力は標準値
function paddleSize() {
  const value = (id) => Number(el(id).value) || DEFAULTS[id];
  return {
    length: (value("paddle") * 2.54) / 100,
    bladeLength: value("bladeLength") / 100,
    bladeWidth: value("bladeWidth") / 100,
    usedDefaults: Object.keys(DEFAULTS).filter((id) => !Number(el(id).value)),
  };
}

function showPaddleCm() {
  const cm = athlete().paddleCm;
  el("paddleCm").textContent = cm ? `（${cm} cm）` : "";
}

// 入力を変えたら選択中の選手に保存（選手がいなければ保存しない）
athleteInputs.forEach((id) => el(id).addEventListener("change", () => {
  if (athletes.currentAthlete(store)) saveAthletes(athletes.updateValues(store, inputValues()));
  else { showPaddleCm(); updateDisplay(); }
}));

// ================= 骨格推定 =================
el("analyze").addEventListener("click", async () => {
  if (!loaded() || analyzing) return;
  const d = data();
  if (!video.videoWidth) return showStatus(playbackProblem());
  analyzing = true;
  stopRequested = false;
  setAnalyzing(true);
  el("progress").textContent = "ライブラリとモデルを読み込み中…";
  const started = performance.now();
  try {
    const { frames, world } = await analyzeVideo(video, fps(), (done, total) => {
      el("progress").textContent = `解析中… ${done} / ${total} フレーム`;
    }, () => stopRequested);
    const found = frames.filter(Boolean).length;
    const seconds = ((performance.now() - started) / 1000).toFixed(0);
    if (stopRequested) {
      el("progress").textContent = "中止しました（結果は保存していません）";
    } else {
      d.pose = frames;
      d.world = world;
      d.body = toBodyFrame(world);
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

// 書き出しのファイル名：選手名_動画名
const baseName = () => [athlete().name, data().name.replace(/\.[^.]+$/, "")].filter(Boolean).join("_");

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
    paddleSizeUsed: paddleSize(),
  };
  download(`${baseName()}_pose.json`, JSON.stringify(buildJSON(meta, d.pose, d.strokes, d.world)), "application/json");
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
    d.world = json.world ?? null;
    d.body = d.world ? toBodyFrame(d.world) : null;
    d.strokes = json.strokes;
    d.fps = json.video.fps;
    fpsInput.value = d.fps;
    el("progress").textContent = `JSONから読み込みました（${json.frames.length} フレーム${d.world ? "" : "、3Dデータなし"}）`;
    renderStrokes();
    updateDisplay();
  } catch (err) {
    alert(`読み込めませんでした：${err.message}`);
  }
});

// ================= 3Dビュー =================
setupView3d(el("view3d"));
document.querySelectorAll("[data-view3d]").forEach((b) => {
  b.addEventListener("click", () => setFixedView(b.dataset.view3d));
});
el("showTrails").addEventListener("change", updateDisplay);

// 3Dビューに渡す内容（現在フレームの骨格・パドル、現在のストロークの軌跡）
function update3d(d, frame) {
  const body = d?.body?.[frame] ?? null;
  const size = paddleSize();
  const paddle = estimatePaddle(body, size);
  const trails = [];
  const n = d ? strokeIndexAt(frame, d.strokes) : -1;
  if (body && n >= 0 && el("showTrails").checked) {
    const range = d.body.slice(d.strokes[n].frame, frame + 1);
    trails.push({ color: COLOR.left, points: range.map((b) => b?.[P.lWrist] ?? null) });
    trails.push({ color: COLOR.right, points: range.map((b) => b?.[P.rWrist] ?? null) });
    trails.push({ color: getComputedStyle(document.documentElement).getPropertyValue("--paddle").trim(), points: range.map((b) => estimatePaddle(b, size)?.tip ?? null) });
  }
  updateView3d(body, paddle, trails);
  el("paddleNote").textContent = size.usedDefaults.length
    ? "パドル寸法の一部は標準値です（選手情報で入力できます）。"
    : "";
}

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

  // 骨格（2D・3D）
  drawSkeleton(overlay, ok && el("showSkeleton").checked ? lm : null);
  update3d(ok ? d : null, frame);

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

selectView("left");
renderAthletes();
