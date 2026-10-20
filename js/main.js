// 画面の操作：各機能（計算・描画・保存）をつなぐ
// 画面の並び：選手 → 動画と3Dモデル（まとめて実行） → フォームの改善点 → 過去データ → ストローク
import { timeToFrame, frameToTime, frameCount, clampFrame, formatTime } from "./frame-math.js";
import { readVideoInfo } from "./mp4-info.js";
import { analyzeVideo } from "./pose.js";
import { P } from "./angles.js";
import { detectStrokes, strokeIndexAt } from "./strokes.js";
import { drawSkeleton, toVideoPoint, nearestJoint, COLOR } from "./overlay.js";
import { buildCSV } from "./export.js";
import { toBodyFrame, estimatePaddle } from "./body3d.js";
import { setupView3d, setFixedView, updateView3d } from "./view3d.js";
import { viewRepresentative, fuseViews, sideDurations } from "./fusion.js";
import { stabilizeLegs } from "./legs.js";
import { spinePoints } from "./spine.js";
import { detectDrive, refineToCatch, releaseFrame } from "./drive.js";
import { buildFeedback } from "./feedback.js";
import * as athletes from "./athletes.js";
import * as sessions from "./sessions.js";
import * as github from "./github.js";

const el = (id) => document.getElementById(id);
const video = el("video");
const overlay = el("overlay");
const seek = el("seek");
const fpsInput = el("fps");

const VIEW_LABELS = { front: "前", left: "左", right: "右", back: "後ろ" };
const SIDE_LABEL = { right: "右漕ぎ", left: "左漕ぎ", all: "全体" };

// 方向ごとのデータ { left: { file, url, name, fps, fpsSource, codec, pose, world, spine, body, strokes }, ... }
//   file・url：動画（動画なしの過去データでは null）
//   pose＝2D画像座標、world＝MediaPipeの3D推定、spine＝シルエットから測った背中の膨らみ
//   body＝worldを選手基準に変換し、足首を固定・膝を拘束した座標（toBody で作る）
const views = {};
let currentView = "left";
let analyzing = false;
let stopRequested = false;
let fused = null;      // 全方向の統合3Dモデル（漕ぐ側ごとの代表ストローク。推定値）
let savedModel = null; // 過去データに保存してあった平均の3Dモデル（全フレームのデータがないときに使う）
let sessionId = null;  // 表示中の過去データのID（新しいデータなら null）
let sessionDate = null;

const data = () => views[currentView];
const toBody = (world) => (world ? stabilizeLegs(toBodyFrame(world)) : null);
const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD

// ================= 再生位置（動画があれば動画、なければ解析結果のフレーム） =================
// 動画を保存していない過去データでも、3Dモデルを再生できるようにする
const hasVideo = () => Boolean(data()?.url) && video.readyState > 0;
const fps = () => Number(fpsInput.value) || 60;
const virtual = { frame: 0, playing: false, last: 0 };

function totalFrames() {
  if (hasVideo()) return frameCount(video.duration || 0, fps());
  return data()?.pose?.length ?? 1;
}

function currentFrame() {
  if (hasVideo()) return clampFrame(timeToFrame(video.currentTime, fps()), totalFrames());
  return clampFrame(virtual.frame, totalFrames());
}

const isPlaying = () => (hasVideo() ? !video.paused : virtual.playing);

function goToFrame(frame) {
  const f = clampFrame(frame, totalFrames());
  if (hasVideo()) video.currentTime = frameToTime(f, fps());
  else { virtual.frame = f; updateDisplay(); }
}

function togglePlay() {
  if (analyzing || !data()) return;
  if (hasVideo()) return video.paused ? video.play() : video.pause();
  virtual.playing = !virtual.playing;
  virtual.last = performance.now();
  if (virtual.playing) requestAnimationFrame(virtualTick);
  updateDisplay();
}

// 動画なしの再生：経過時間 × fps × 速度 だけフレームを進める
function virtualTick(now) {
  if (!virtual.playing || hasVideo()) return;
  virtual.frame += ((now - virtual.last) / 1000) * fps() * Number(el("speed").value);
  virtual.last = now;
  if (virtual.frame >= totalFrames() - 1) virtual.frame = 0;
  updateDisplay();
  requestAnimationFrame(virtualTick);
}

function stepFrame(delta) {
  if (analyzing || !data()) return;
  if (hasVideo()) video.pause();
  virtual.playing = false;
  goToFrame(currentFrame() + delta);
}

el("play").addEventListener("click", togglePlay);
el("prev").addEventListener("click", () => stepFrame(-1));
el("next").addEventListener("click", () => stepFrame(1));
el("speed").addEventListener("change", (e) => (video.playbackRate = Number(e.target.value)));
seek.addEventListener("input", () => goToFrame(Number(seek.value)));

document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT"].includes(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.code === "Enter" && editorOpen()) { e.preventDefault(); setCatch(); }
  if (e.code === "ArrowLeft") stepFrame(-1);
  if (e.code === "ArrowRight") stepFrame(1);
});

video.addEventListener("play", function tick() {
  updateDisplay();
  if (!video.paused) requestAnimationFrame(tick);
});
video.addEventListener("pause", updateDisplay);
video.addEventListener("seeked", updateDisplay);

// ================= 選手（動画の前に選ぶ。選手ごとにブラウザ内へ保存） =================
const athleteInputs = ["height", "weight", "paddle", "bladeLength", "bladeWidth"];
const DEFAULTS = { paddle: 50, bladeLength: 48, bladeWidth: 25 }; // 未入力時の標準値（inch、cm、cm）

let store = athletes.loadStore(localStorage);
if (store.list.length) athletes.saveStore(localStorage, store); // 引き継いだ保存をすぐ確定する

const inputValues = () => Object.fromEntries(athleteInputs.map((id) => [id, el(id).value]));

function saveAthletes(next) {
  store = next;
  const ok = athletes.saveStore(localStorage, store);
  el("athleteNote").textContent = ok ? "" : "このブラウザでは保存できません（バックアップで書き出してください）";
  renderAthletes();
}

function renderAthletes() {
  const select = el("athleteSelect");
  select.innerHTML = "";
  if (!store.list.length) select.add(new Option("（選手を追加してください）", ""));
  store.list.forEach((a) => select.add(new Option(a.name, a.id, false, a.id === store.current)));
  const values = athletes.currentAthlete(store)?.values ?? {};
  athleteInputs.forEach((id) => (el(id).value = values[id] ?? ""));
  Object.entries(DEFAULTS).forEach(([id, v]) => (el(id).placeholder = `標準 ${v}`));
  const inch = Number(el("paddle").value);
  el("paddleCm").textContent = inch ? `（${Math.round(inch * 25.4) / 10} cm）` : "";
  renderSessions();
  updateDisplay();
}

el("athleteSelect").addEventListener("change", (e) => {
  startNewData(); // 選手を変えたら、表示中のデータは閉じる（別の選手のデータとして保存しないため）
  saveAthletes({ ...store, current: e.target.value });
});

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
  if (a && confirm(`${a.name} を削除しますか？（元に戻せません。過去データは残ります）`)) saveAthletes(athletes.removeAthlete(store, a.id));
});

athleteInputs.forEach((id) => el(id).addEventListener("change", () => {
  if (athletes.currentAthlete(store)) saveAthletes(athletes.updateValues(store, inputValues()));
  else renderAthletes();
}));

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

// ================= 動画の読み込み（PC内で処理） =================
document.querySelectorAll(".tab[data-view]").forEach((tab) => {
  tab.addEventListener("click", () => !analyzing && selectView(tab.dataset.view));
});

function selectView(view) {
  currentView = view;
  el("strokeEditor").hidden = true;
  virtual.playing = false;
  virtual.frame = 0;
  document.querySelectorAll(".tab[data-view]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === view);
    tab.classList.toggle("loaded", Boolean(views[tab.dataset.view]));
  });
  const d = data();
  if (d?.url) video.src = d.url;
  else { video.removeAttribute("src"); video.load(); }
  if (d) fpsInput.value = d.fps;
  el("fileName").textContent = d ? d.name : "未選択";
  el("fpsBox").hidden = !d || d.fpsSource !== "manual";
  showStatus(!d ? "「動画を選択」から、この方向の動画を読み込んでください"
    : d.url ? "読み込み中…"
    : `このデータは動画を保存していません（${d.name}）。「3Dモデル」で表示できます。同じ動画を選ぶと動画も表示されます`);
  renderStrokes();
  updateDisplay();
}

el("fileInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const old = views[currentView];

  // 動画なしの過去データに、同じ名前の動画を付け直す（解析結果はそのまま）
  if (old?.pose && !old.url && old.name === file.name) {
    old.file = file;
    old.url = URL.createObjectURL(file);
    return selectView(currentView);
  }
  // 過去データを表示中に別の動画を選んだら、新しいデータとして始める
  if (sessionId) startNewData();
  if (views[currentView]?.url) URL.revokeObjectURL(views[currentView].url);

  const info = readVideoInfo(new DataView(await file.arrayBuffer())); // fpsは動画のヘッダから読む
  views[currentView] = {
    file,
    url: URL.createObjectURL(file),
    name: file.name,
    fps: info ? info.fps : fps(),
    fpsSource: info ? "video" : "manual",
    codec: info?.codec ?? null,
    pose: null,
    world: null,
    spine: null,
    body: null,
    strokes: [],
  };
  selectView(currentView);
  dataChanged();
});

fpsInput.addEventListener("change", () => {
  if (data()) data().fps = fps();
  updateDisplay();
});

video.addEventListener("loadedmetadata", () => {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  el("videoBox").style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`; // 縦長動画にも合わせる
  updateDisplay();
});

// ---- 動画を表示できないときに理由を出す ----
const HEVC_HELP = "スマホの動画はHEVC（H.265）形式です。Chrome・Edgeで表示できない場合は、パソコンにHEVC対応がない可能性があります。カメラ設定をH.264（互換性優先）にして撮影するか、H.264に変換してください。";

function showStatus(text) {
  el("videoStatus").textContent = text;
  el("videoStatus").hidden = !text;
}

function playbackProblem() {
  const isHevc = ["hvc1", "hev1"].includes(data()?.codec);
  return "この動画はこのブラウザで表示できません。" + (isHevc ? HEVC_HELP : "MP4（H.264）形式の動画を使ってください。");
}

video.addEventListener("loadeddata", () => showStatus(video.videoWidth ? "" : playbackProblem()));
video.addEventListener("error", () => data()?.url && showStatus(playbackProblem()));

// ================= 動画と3Dモデルの切り替え =================
document.querySelectorAll(".tab[data-display]").forEach((tab) => {
  tab.addEventListener("click", () => showDisplay(tab.dataset.display));
});

function showDisplay(name) {
  document.querySelectorAll(".tab[data-display]").forEach((t) => t.classList.toggle("active", t.dataset.display === name));
  el("videoBox").hidden = name !== "video";
  el("modelBox").hidden = name !== "model";
  updateDisplay();
}

// ---- 代表ストロークの繰り返し再生（動画とは別の時計で動く） ----
const loop = { phase: 0, playing: true, running: false, last: 0 };
const loopSide = () => document.querySelector("input[name=loopSide]:checked").value;
const loopVisible = () => !el("modelBox").hidden && document.querySelector("input[name=mode3d]:checked").value === "fused";

function startLoop() {
  if (loop.running || !loop.playing || !loopVisible()) return;
  loop.running = true;
  loop.last = performance.now();
  requestAnimationFrame(loopTick);
}

// 経過時間 ÷ 平均ストローク時間 だけ位相（0〜100%）を進める
function loopTick(now) {
  if (!loop.playing || !loopVisible()) { loop.running = false; return; }
  const sec = fused?.duration?.[loopSide()] ?? 1.3;
  const speed = Number(el("loopSpeed").value); // 1・1/2・1/4倍速
  loop.phase = (loop.phase + (((now - loop.last) / 1000) / sec) * 100 * speed) % 101;
  loop.last = now;
  updateDisplay();
  requestAnimationFrame(loopTick);
}

el("loopPlay").addEventListener("click", () => {
  loop.playing = !loop.playing;
  updateDisplay();
});
el("loopPhase").addEventListener("input", (e) => {
  loop.playing = false;
  loop.phase = Number(e.target.value);
  updateDisplay();
});
document.querySelectorAll("input[name=loopSide]").forEach((r) => r.addEventListener("change", updateDisplay));

setupView3d(el("view3d"));
document.querySelectorAll("[data-view3d]").forEach((b) => b.addEventListener("click", () => setFixedView(b.dataset.view3d)));
document.querySelectorAll("input[name=mode3d]").forEach((r) => r.addEventListener("change", updateDisplay));
el("showTrails").addEventListener("change", updateDisplay);
Object.keys(VIEW_LABELS).forEach((v) => el(`fuse-${v}`).addEventListener("change", dataChanged));

// ================= 解析 =================
const runStatus = (text) => (el("runAllStatus").textContent = text);

function waitForVideo() {
  return new Promise((resolve) => {
    if (video.readyState >= 2) return resolve();
    video.addEventListener("loadeddata", resolve, { once: true });
    video.addEventListener("error", resolve, { once: true });
  });
}

// 今の方向の動画を解析する。成功したら true
async function analyzeCurrent(label) {
  const d = data();
  if (!video.videoWidth) { showStatus(playbackProblem()); runStatus(`${label}：動画を表示できないため解析できません`); return false; }
  stopRequested = false;
  const { frames, world, spine } = await analyzeVideo(video, fps(), (done, total) => {
    runStatus(`${label}… ${done} / ${total} フレーム`);
  }, () => stopRequested);
  if (stopRequested) return false;
  d.pose = frames;
  d.world = world;
  d.spine = spine;
  d.body = toBody(world);
  d.strokes = refineToCatch(detectStrokes(frames, fps()), d.body); // 区切り＝キャッチ（推定）
  return true;
}

function setAnalyzing(on) {
  analyzing = on;
  ["runAll", "saveSession", "detect", "fileInput"].forEach((id) => (el(id).disabled = on));
  el("stop").disabled = !on;
}

el("stop").addEventListener("click", () => (stopRequested = true));

// ================= まとめて実行：解析 → 3Dモデル → 保存 =================
el("runAll").addEventListener("click", async () => {
  if (analyzing) return;
  if (!athletes.currentAthlete(store)) return runStatus("先に選手を追加・選択してください（保存先になります）");
  const targets = Object.keys(VIEW_LABELS).filter((v) => views[v]?.url && !views[v].pose);
  const analyzedBefore = Object.keys(views).filter((v) => views[v].pose);
  if (!targets.length && !analyzedBefore.length) return runStatus("動画が読み込まれていません。各方向のタブで動画を選択してください");

  // 1. 解析（解析済みの方向はそのまま使う）
  setAnalyzing(true);
  let ok = true;
  try {
    for (const [n, v] of targets.entries()) {
      selectView(v);
      await waitForVideo();
      if (!(await analyzeCurrent(`1/3 ${VIEW_LABELS[v]}を解析中（${n + 1} / ${targets.length}）`))) { ok = false; break; }
    }
  } catch (err) {
    ok = false;
    runStatus(`解析に失敗しました：${err.message}`);
  }
  setAnalyzing(false);
  dataChanged();
  if (!ok) {
    if (stopRequested) runStatus("中止しました。保存はしていません。");
    return;
  }

  // 2. 3Dモデル
  if (!fused?.right && !fused?.left) {
    return runStatus("2/3 3Dモデルを作れませんでした（ストロークを検出できていない可能性）。下のストローク表を確認してください。保存はしていません。");
  }
  document.querySelector("input[name=mode3d][value=fused]").checked = true;

  // 3. 保存
  runStatus("3/3 保存中…");
  const saved = await saveCurrentSession();
  runStatus(saved ? `完了：解析・3Dモデル・保存が終わりました。${el("fusionInfo").textContent}` : "3/3 保存できませんでした。");
  showDisplay("model");
});

// ================= 統合3Dモデルとフォームの改善点 =================
// 解析結果・ストロークが変わったら呼ぶ
function dataChanged() {
  const usable = Object.entries(views).filter(([v, d]) => d?.body && d.strokes.length > 1 && el(`fuse-${v}`).checked);
  const info = Object.entries(views)
    .filter(([v, d]) => d.strokes.length > 1 && el(`fuse-${v}`).checked)
    .map(([name, d]) => ({ name, fps: d.fps, strokes: d.strokes }));
  if (usable.length) {
    fused = fuseViews(Object.fromEntries(usable.map(([v, d]) => [v, viewRepresentative(d)])));
    fused.duration = sideDurations(info); // 繰り返し再生の速さ（平均ストローク時間）
  } else {
    fused = savedModel; // 全フレームのデータがない過去データは、保存してある平均モデルを使う
  }

  const describe = (side) => {
    const f = fused?.[side];
    return `${SIDE_LABEL[side]}：` + (f ? Object.entries(f.strokes).map(([v, n]) => `${VIEW_LABELS[v]}${n}本`).join("・") : "データなし");
  };
  el("fusionInfo").textContent = fused ? `統合に使ったストローク… ${describe("right")}／${describe("left")}` : "";
  renderFeedback(info);
  renderStrokes();
  updateDisplay();
}

function renderFeedback(usedViews) {
  const body = el("feedbackList");
  body.innerHTML = "";
  el("feedbackEmpty").hidden = Boolean(fused);
  if (!fused) return;
  for (const row of buildFeedback(fused, usedViews)) {
    const value = Object.entries(row.values)
      .filter(([, v]) => v != null)
      .map(([side, v]) => `${SIDE_LABEL[side]} ${v.toFixed(1)}${row.unit}`)
      .join("<br>") || "--";
    const parts = [];
    if (row.reason) parts.push(`<span class="muted">${row.reason}</span>`);
    if (row.flagged.length) parts.push(`<span class="flag">改善候補（${row.flagged.map((s) => SIDE_LABEL[s]).join("・")}）</span><br>${row.comment}`);
    if (row.lr) parts.push(`<span class="flag lr">左右差</span><br>${row.lr}`);
    if (!parts.length) parts.push('<span class="muted">目安の範囲内・左右差なし</span>');
    if (row.note) parts.push(`<span class="muted">${row.note}</span>`);
    if (row.details?.length) parts.push(`<ul class="details">${row.details.map((d) => `<li>${d}</li>`).join("")}</ul>`);
    if (row.basis?.length) parts.push(`<span class="muted small">根拠：${row.basis.join("／")}</span>`);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.label}${row.extra ? `<br><span class="muted">${row.extra}</span>` : ""}</td><td>${value}</td><td>${parts.join("<br>")}</td>`;
    body.appendChild(tr);
  }
}

// ================= 保存（ブラウザ内。設定によりGitHubにも） =================
async function saveCurrentSession() {
  const a = athletes.currentAthlete(store);
  if (!a) { el("sessionNote").textContent = "選手が選ばれていないため保存できません"; return false; }
  const session = sessions.buildSession({ id: sessionId, athlete: a, date: sessionDate ?? today(), memo: el("sessionMemo").value, views, model: fused });
  const videos = el("saveVideo").checked
    ? Object.fromEntries(Object.entries(views).filter(([, d]) => d.file).map(([v, d]) => [v, d.file]))
    : {};
  try {
    sessions.requestPersist();
    await sessions.saveSession(session, videos);
  } catch (err) {
    el("sessionNote").textContent = `保存できませんでした：${err.message}`;
    return false;
  }
  sessionId = session.id;
  sessionDate = session.date;
  el("sessionNote").textContent = `保存しました（${new Date().toLocaleTimeString()}）`;
  showSessionLabel();
  renderSessions();
  await uploadToGitHub(session);
  return true;
}

el("saveSession").addEventListener("click", () => {
  if (!Object.keys(views).length) return alert("データがありません");
  saveCurrentSession();
});

// ---- GitHubへの自動保存（解析結果のみ） ----
const GITHUB_KEY = "oc-form-github";
let ghSettings = { ...github.DEFAULT_SETTINGS };
try { ghSettings = { ...ghSettings, ...JSON.parse(localStorage.getItem(GITHUB_KEY)) }; } catch { /* 保存なし */ }
el("ghEnabled").checked = ghSettings.enabled;
el("rawExport").checked = ghSettings.raw;
el("rawExport").addEventListener("change", () => saveGhSettings());
el("ghToken").value = ghSettings.token;
el("ghRepo").textContent = `${ghSettings.owner}/${ghSettings.repo}（${ghSettings.branch} ブランチ）`;

function saveGhSettings() {
  ghSettings = { ...ghSettings, enabled: el("ghEnabled").checked, token: el("ghToken").value.trim(), raw: el("rawExport").checked };
  try { localStorage.setItem(GITHUB_KEY, JSON.stringify(ghSettings)); } catch { /* 保存できない環境 */ }
}

el("ghEnabled").addEventListener("change", saveGhSettings);
el("ghToken").addEventListener("change", saveGhSettings);

el("ghTest").addEventListener("click", async () => {
  saveGhSettings();
  el("ghNote").textContent = "確認中…";
  try {
    const info = await github.testConnection(ghSettings);
    el("ghNote").textContent = `接続できました（${info.private ? "非公開" : "公開"}リポジトリ）。`;
  } catch (err) {
    el("ghNote").textContent = `接続できません：${err.message}`;
  }
});

// 失敗してもブラウザ内の保存はそのまま
async function uploadToGitHub(session) {
  if (!ghSettings.enabled) return;
  if (!ghSettings.token) { el("ghNote").textContent = "トークンが未入力のため、GitHubには保存していません。"; return; }
  el("ghNote").textContent = "GitHubに保存中…";
  try {
    const url = await github.uploadSession(ghSettings, session);
    el("ghNote").innerHTML = "";
    el("ghNote").append("GitHubに保存しました：", Object.assign(document.createElement("a"), { href: url, target: "_blank", textContent: github.sessionPath(session) }));
  } catch (err) {
    el("ghNote").textContent = `GitHubに保存できませんでした（ブラウザ内には保存済み）：${err.message}`;
  }
}

// ================= 過去データ読み出し =================
function showSessionLabel() {
  el("sessionLabel").textContent = sessionId ? `${sessionDate} ${el("sessionMemo").value}` : "新しいデータ（未保存）";
}

function clearViews() {
  for (const v of Object.keys(views)) {
    if (views[v].url) URL.revokeObjectURL(views[v].url);
    delete views[v];
  }
}

// 表示中のデータを閉じて、新しいデータを始める（保存済みのデータは消えない）
function startNewData() {
  clearViews();
  sessionId = null;
  savedModel = null;
  sessionDate = null;
  el("sessionMemo").value = "";
  showSessionLabel();
  selectView(currentView);
  dataChanged();
}

async function openSession(id) {
  if (analyzing) return;
  const s = await sessions.getSession(id);
  clearViews();
  for (const [view, r] of Object.entries(s.views)) {
    const blob = await sessions.getVideo(id, view);
    views[view] = {
      file: blob ?? null,
      url: blob ? URL.createObjectURL(blob) : null,
      name: r.video.name,
      fps: r.video.fps,
      fpsSource: r.video.fpsSource,
      codec: r.video.codec,
      pose: r.pose,
      world: r.world,
      spine: r.spine ?? null,
      body: toBody(r.world),
      strokes: r.strokes,
    };
  }
  sessionId = id;
  sessionDate = s.date;
  savedModel = s.model ?? null;
  el("sessionMemo").value = s.memo;
  showSessionLabel();
  selectView(Object.keys(views)[0] ?? "left");
  dataChanged();
  if (!data()?.url) showDisplay("model"); // 動画がなければ3Dモデルを表示
  renderSessions();
}

async function renderSessions() {
  const body = el("sessionList");
  body.innerHTML = "";
  const a = athletes.currentAthlete(store);
  if (!a) return;
  let list = [];
  try {
    list = sessions.sortSessions(await sessions.listSessions(a.id));
  } catch (err) {
    el("sessionNote").textContent = `保存データを読めません：${err.message}`;
  }
  el("sessionCount").textContent = `（${list.length} 件）`;
  for (const s of list) {
    const row = document.createElement("tr");
    row.className = s.id === sessionId ? "clickable current" : "clickable";
    row.innerHTML = '<td></td><td></td><td><button class="btn small">削除</button></td>';
    row.children[0].textContent = s.date;
    row.children[1].textContent = s.memo; // メモは文字としてそのまま表示
    row.addEventListener("click", () => openSession(s.id));
    row.querySelector("button").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`${s.date} ${s.memo} を削除しますか？（元に戻せません）`)) return;
      await sessions.deleteSession(s.id);
      if (sessionId === s.id) { sessionId = null; showSessionLabel(); }
      renderSessions();
    });
    body.appendChild(row);
  }
  const usage = await sessions.storageUsage();
  el("storageUsage").textContent = usage ? `使用量 ${usage.usedMB} MB` : "";
}

// ---- 書き出し・読み込み ----
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}

el("exportSession").addEventListener("click", async () => {
  if (!sessionId) return alert("保存したデータを表示しているときに書き出せます（先に保存してください）");
  const s = await sessions.getSession(sessionId);
  download(`${s.athleteName}_${s.date}_${s.id}.json`, JSON.stringify(sessions.buildSessionFile(s, { raw: el("rawExport").checked })), "application/json");
});

el("exportCSV").addEventListener("click", () => {
  const d = data();
  if (!d?.pose) return alert("この方向の解析結果がありません");
  const name = [athletes.currentAthlete(store)?.name, sessionDate ?? today(), currentView].filter(Boolean).join("_");
  download(`${name}.csv`, buildCSV(d.pose, d.fps, d.strokes), "text/csv");
});

// 書き出したJSON（GitHubに保存したものも同じ形式）を過去データに追加して表示する
el("importSession").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) importSessionText(await file.text());
});

// GitHubの保存データの一覧を出す。行を押すと読み込んで表示する
el("ghList").addEventListener("click", async () => {
  const body = el("ghSessionList");
  body.innerHTML = "<tr><td>読み込み中…</td></tr>";
  try {
    const list = await github.listSavedSessions(ghSettings);
    body.innerHTML = list.length ? "" : "<tr><td>GitHubに保存されたデータはありません</td></tr>";
    for (const item of list) {
      const row = document.createElement("tr");
      row.className = "clickable";
      row.innerHTML = "<td></td><td></td>";
      row.children[0].textContent = item.athlete;
      row.children[1].textContent = item.name;
      row.addEventListener("click", async () => {
        el("sessionNote").textContent = "GitHubから読み込み中…";
        const res = await fetch(github.rawUrl(ghSettings, item.path));
        if (!res.ok) return alert(`読み込めませんでした（${res.status}）`);
        importSessionText(await res.text());
      });
      body.appendChild(row);
    }
  } catch (err) {
    body.innerHTML = "";
    el("sessionNote").textContent = `GitHubの一覧を読めません：${err.message}`;
  }
});

async function importSessionText(text) {
  try {
    const s = sessions.parseSessionFile(text);
    // 選手：同じIDか同じ名前の選手に入れる。いなければ追加する
    let a = store.list.find((x) => x.id === s.athleteId) ?? store.list.find((x) => x.name === s.athleteName);
    if (!a) {
      saveAthletes(athletes.addAthlete(store, s.athleteName ?? "読み込んだ選手", s.athleteValues ?? {}));
      a = athletes.currentAthlete(store);
    } else if (store.current !== a.id) {
      saveAthletes({ ...store, current: a.id });
    }
    await sessions.saveSession({ ...s, athleteId: a.id, athleteName: a.name }, {});
    await openSession(s.id);
    el("sessionNote").textContent = `読み込みました（${s.date} ${s.memo}）`;
  } catch (err) {
    alert(`読み込めませんでした：${err.message}`);
  }
}

// ================= ストローク（必要なときだけ手で直す） =================
el("detect").addEventListener("click", () => {
  const d = data();
  if (!d?.pose) return alert("この方向はまだ解析していません");
  if (d.strokes.some((s) => s.src === "manual") && !confirm("手で設定したキャッチもやり直されます。よろしいですか？")) return;
  d.strokes = refineToCatch(detectStrokes(d.pose, d.fps), d.body);
  dataChanged();
});

el("addStroke").addEventListener("click", () => {
  const d = data();
  if (!d?.pose) return;
  const frame = currentFrame();
  if (d.strokes.some((s) => s.frame === frame)) return;
  d.strokes.push({ frame, side: null, src: "manual" });
  d.strokes.sort((a, b) => a.frame - b.frame);
  dataChanged();
});

function renderStrokes() {
  const strokes = data()?.strokes ?? [];
  const body = el("strokeList");
  body.innerHTML = "";
  el("strokeCount").textContent = strokes.length > 1 ? `（${VIEW_LABELS[currentView]}・${strokes.length - 1} ストローク）` : "";

  strokes.forEach((s, n) => {
    const last = n === strokes.length - 1;
    const release = releaseFrame(strokes, n, data().body);
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${last ? "終端" : n + 1}</td>
      <td><button class="link">${formatTime(s.frame / fps())}</button> ${s.src === "manual" ? '<span class="muted">手で設定</span>' : ""}</td>
      <td>${release == null ? "--" : formatTime(release / fps())}</td>
      <td>${last ? "" : `<select class="btn small">
        <option value="">不明</option>
        <option value="left" ${s.side === "left" ? "selected" : ""}>左</option>
        <option value="right" ${s.side === "right" ? "selected" : ""}>右</option>
      </select>`}</td>
      <td><button class="btn small">削除</button></td>`;
    row.querySelector(".link").addEventListener("click", () => { video.pause(); virtual.playing = false; goToFrame(s.frame); });
    row.querySelector("select")?.addEventListener("change", (e) => {
      s.side = e.target.value || null;
      dataChanged();
    });
    row.querySelector("td:last-child button").addEventListener("click", () => {
      strokes.splice(n, 1);
      dataChanged();
    });
    body.appendChild(row);
  });
  renderEditor();
}

// ================= ストロークの区切りの編集（キャッチを手で設定） =================
let editIndex = 0;
const editorOpen = () => !el("strokeEditor").hidden;

el("editStrokes").addEventListener("click", () => {
  if (!data()?.strokes?.length) return alert("この方向にはストロークがありません（先に解析してください）");
  if (!hasVideo()) return alert("動画を表示できるときに編集できます");
  showDisplay("video");
  el("strokeEditor").hidden = false;
  el("strokeEditor").scrollIntoView({ block: "center", behavior: "smooth" });
  openEdit(0);
});

el("editClose").addEventListener("click", () => (el("strokeEditor").hidden = true));
el("editPrev").addEventListener("click", () => openEdit(editIndex - 1));
el("editNext").addEventListener("click", () => openEdit(editIndex + 1));
el("editNo").addEventListener("change", (e) => openEdit(Number(e.target.value)));
el("editCatch").addEventListener("click", setCatch);

// No.n を開き、その開始位置へ動画を動かす
function openEdit(n) {
  const strokes = data().strokes;
  editIndex = Math.min(Math.max(n, 0), strokes.length - 1);
  video.pause();
  goToFrame(strokes[editIndex].frame);
  renderEditor();
}

// 今の位置を No.n のキャッチ（開始）にして、次の No へ進む
function setCatch() {
  const strokes = data().strokes;
  const frame = currentFrame();
  const prev = strokes[editIndex - 1];
  const next = strokes[editIndex + 1];
  if ((prev && frame <= prev.frame) || (next && frame >= next.frame)) {
    el("editInfo").textContent = `前後のストロークの開始（No.${editIndex}〜No.${editIndex + 2}）の間に置いてください。`;
    return;
  }
  strokes[editIndex] = { ...strokes[editIndex], frame, src: "manual" };
  dataChanged();
  if (editIndex < strokes.length - 1) openEdit(editIndex + 1);
  else el("editInfo").textContent = "最後まで設定しました。ストローク欄の「修正を保存」で保存してください。";
}

function renderEditor() {
  if (!editorOpen() || !data()) return;
  const strokes = data().strokes;
  const select = el("editNo");
  select.innerHTML = "";
  strokes.forEach((_, n) => select.add(new Option(n === strokes.length - 1 ? `終端` : `${n + 1}`, n, false, n === editIndex)));
  el("editView").textContent = VIEW_LABELS[currentView];
  const s = strokes[editIndex];
  const release = releaseFrame(strokes, editIndex, data().body);
  el("editInfo").textContent = `No.${editIndex + 1} / ${strokes.length - 1}：今の開始 ${formatTime(s.frame / fps())}（${s.src === "manual" ? "手で設定" : "自動推定"}）`
    + `、力が抜けた位置（推定）${release == null ? "--" : formatTime(release / fps())}、${SIDE_LABEL[s.side] ?? "漕ぐ側不明"}`;
}

// ================= 関節のドラッグ修正（停止中のみ） =================
let dragging = null;

overlay.addEventListener("pointerdown", (e) => {
  const lm = data()?.pose?.[currentFrame()];
  if (!lm || isPlaying() || analyzing) return;
  dragging = nearestJoint(lm, toVideoPoint(overlay, e));
  if (dragging != null) overlay.setPointerCapture(e.pointerId);
});

overlay.addEventListener("pointermove", (e) => {
  if (dragging == null) return;
  const p = toVideoPoint(overlay, e);
  data().pose[currentFrame()][dragging] = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, v: 1, src: "manual" };
  updateDisplay();
});

overlay.addEventListener("pointerup", () => (dragging = null));

// ================= 表示の更新 =================
// 3Dビューに渡す内容（現在の骨格・パドル・軌跡）
function update3d(d, frame) {
  const size = paddleSize();
  const mode = document.querySelector("input[name=mode3d]:checked").value;
  let body = null;
  let spine = null;
  let range = [];  // 軌跡を描く区間（ストロークの始まり〜今）
  let drive = [];  // その区間のうち力を入れているところ
  let side = null; // 漕ぐ側（パドルの向きを固定するため）

  if (mode === "fused") {
    // 代表ストローク（平均）を、平均ストローク時間で繰り返し再生する
    side = loopSide();
    const rep = fused?.[side];
    const index = Math.min(100, Math.floor(loop.phase));
    body = rep?.frames[index] ?? null;
    if (body) {
      spine = spinePoints(body, rep.spine?.[index] ?? null);
      range = rep.frames.slice(0, index + 1);
      drive = detectDrive(rep.frames, side)?.mask.slice(0, index + 1) ?? [];
    }
    const sec = fused?.duration?.[side];
    el("loopPhase").value = index;
    el("loopPlay").textContent = loop.playing ? "⏸ 停止" : "▶ 再生";
    el("mode3dInfo").textContent = !fused ? "統合モデルはまだありません（解析すると作られます）"
      : !rep ? `${SIDE_LABEL[side]}のデータがありません`
      : `代表ストローク：${SIDE_LABEL[side]} ${index}%（${rep.views.map((v) => VIEW_LABELS[v]).join("・")}の動画の平均${sec ? `、1ストローク ${sec.toFixed(2)}秒` : ""}）。0%＝キャッチ`;
  } else {
    body = d?.body?.[frame] ?? null;
    if (body) spine = spinePoints(body, d.spine?.[frame] ?? null);
    const n = d ? strokeIndexAt(frame, d.strokes) : -1;
    if (body && n >= 0) {
      const start = d.strokes[n].frame;
      side = d.strokes[n].side;
      range = d.body.slice(start, frame + 1);
      drive = detectDrive(d.body.slice(start, d.strokes[n + 1].frame), side)?.mask.slice(0, range.length) ?? [];
    }
    el("mode3dInfo").textContent = d ? `この動画（${VIEW_LABELS[currentView]}）だけの推定` : "";
  }

  const trails = [];
  if (body && range.length && el("showTrails").checked) {
    const paddleColor = getComputedStyle(document.documentElement).getPropertyValue("--paddle").trim();
    trails.push({ color: COLOR.left, points: range.map((b) => b?.[P.lWrist] ?? null), drive });
    trails.push({ color: COLOR.right, points: range.map((b) => b?.[P.rWrist] ?? null), drive });
    trails.push({ color: paddleColor, points: range.map((b) => estimatePaddle(b, size, side)?.tip ?? null), drive });
  }
  updateView3d(body, estimatePaddle(body, size, side), trails, spine);
  el("paddleNote").textContent = size.usedDefaults.length ? "パドル寸法の一部は標準値です（選手欄で入力できます）。" : "";
}

function updateDisplay() {
  const d = data();
  const frame = d ? currentFrame() : 0;
  seek.max = d ? totalFrames() - 1 : 0;
  seek.value = frame;
  el("play").textContent = isPlaying() ? "⏸ 停止" : "▶ 再生";
  drawSkeleton(overlay, hasVideo() ? d?.pose?.[frame] ?? null : null);
  // 代表ストロークの再生中は動画の操作を隠す（動画とは別に動くため）
  el("videoControls").hidden = loopVisible();
  el("loopControls").hidden = !loopVisible();
  if (!el("modelBox").hidden) update3d(d, frame);
  startLoop();
}

renderAthletes();
selectView("left");
