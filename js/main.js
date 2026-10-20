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
import * as sessions from "./sessions.js";
import { viewRepresentative, fuseViews, phaseAt } from "./fusion.js";
import { buildFeedback } from "./feedback.js";
import * as github from "./github.js";

const el = (id) => document.getElementById(id);
const video = el("video");
const overlay = el("overlay");
const chart = el("chart");
const seek = el("seek");
const fpsInput = el("fps");

const VIEW_LABELS = { front: "前", left: "左", right: "右", back: "後ろ" };
const ANGLE_LABELS = { ...Object.fromEntries(Object.entries(ANGLES).map(([k, a]) => [k, a.label])), trunk: TRUNK_LABEL };

// 方向ごとのデータ { left: { file, url, name, fps, fpsSource, pose, world, body, strokes }, ... }
// file＝動画ファイル（保存用）。保存済みセッションを動画なしで開いたときは file・url が null
// pose＝2D画像座標、world＝MediaPipeの3D推定、body＝worldを選手基準に変換した座標
const views = {};
let currentView = "front";
let stopRequested = false;
let analyzing = false;

const data = () => views[currentView];
const fps = () => Number(fpsInput.value) || 60;
const totalFrames = () => frameCount(video.duration || 0, fps());
const currentFrame = () => clampFrame(timeToFrame(video.currentTime, fps()), totalFrames());
const loaded = () => Boolean(data()?.url) && video.readyState > 0;

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
  if (d?.url) {
    video.src = d.url;
  } else {
    video.removeAttribute("src");
    video.load();
  }
  if (d) fpsInput.value = d.fps;
  el("fileName").textContent = d ? d.name : "未選択";
  el("fpsSource").textContent = d ? d.fpsSource : "";
  el("progress").textContent = d?.pose ? `解析済み（${d.pose.length} フレーム）` : "未解析";
  showStatus(!d ? "「動画を選択」から、この方向の動画を読み込んでください"
    : d.url ? "読み込み中…"
    : `動画は保存されていません。「動画を選択」で ${d.name} を選ぶと、解析結果と一緒に表示されます`);
  renderStrokes();
  updateDisplay();
}

// ================= 動画の読み込み（PC内で処理） =================
el("fileInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const old = views[currentView];
  if (old?.url) URL.revokeObjectURL(old.url);

  // 保存済みの解析結果があり、同じ名前の動画なら、解析結果をそのまま使う
  if (old?.pose && !old.url && old.name === file.name) {
    old.file = file;
    old.url = URL.createObjectURL(file);
    return selectView(currentView);
  }

  // fpsは動画のヘッダから読む。読めなければ手入力
  const info = readVideoInfo(new DataView(await file.arrayBuffer()));
  views[currentView] = {
    file,
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
  renderSessions();
}

el("athleteSelect").addEventListener("change", (e) => {
  // 選手を変えたら、開いているデータは「新規」扱い（保存すると新しい選手のデータになる）
  sessionId = null;
  setSessionLabel("新規（未保存）");
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

// ================= セッションの保存（ブラウザ内のIndexedDB） =================
let sessionId = null; // 開いている保存済みセッション（新規なら null）
const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
el("sessionDate").value = today();

function setSessionLabel(text) {
  el("sessionLabel").textContent = text;
}

el("saveSession").addEventListener("click", () => {
  if (!athletes.currentAthlete(store)) return alert("先に選手を追加・選択してください");
  if (!Object.keys(views).length) return alert("動画が読み込まれていません");
  saveCurrentSession();
});

// 開いているデータを保存する（開いたセッションなら上書き）。成功したら true
async function saveCurrentSession() {
  const a = athletes.currentAthlete(store);
  let ok = false;
  const keepVideo = el("saveVideo").checked;
  const session = sessions.buildSession({
    id: sessionId, athlete: a, date: el("sessionDate").value || today(), memo: el("sessionMemo").value, views,
  });
  const videos = keepVideo
    ? Object.fromEntries(Object.entries(views).filter(([, d]) => d.file).map(([v, d]) => [v, d.file]))
    : {};
  el("sessionNote").textContent = "保存中…";
  try {
    sessions.requestPersist();
    await sessions.saveSession(session, videos);
    sessionId = session.id;
    setSessionLabel(`保存済み：${session.date} ${session.memo}`);
    el("sessionNote").textContent = `保存しました（${new Date().toLocaleTimeString()}）`;
    ok = true;
  } catch (err) {
    el("sessionNote").textContent = `保存できませんでした：${err.message}`;
  }
  renderSessions();
  if (ok) await uploadToGitHub(session);
  return ok;
}

// ================= GitHubへの自動保存（解析結果のみ） =================
const GITHUB_KEY = "oc-form-github";
let ghSettings = { ...github.DEFAULT_SETTINGS };
try { ghSettings = { ...ghSettings, ...JSON.parse(localStorage.getItem(GITHUB_KEY)) }; } catch { /* 保存なし */ }
el("ghEnabled").checked = ghSettings.enabled;
el("ghToken").value = ghSettings.token;
el("ghRepo").textContent = `${ghSettings.owner}/${ghSettings.repo}（${ghSettings.branch} ブランチ）`;

function saveGhSettings() {
  ghSettings = { ...ghSettings, enabled: el("ghEnabled").checked, token: el("ghToken").value.trim() };
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

// ローカル保存のあとに呼ぶ。失敗してもローカルの保存はそのまま
async function uploadToGitHub(session) {
  if (!ghSettings.enabled) return;
  if (!ghSettings.token) {
    el("ghNote").textContent = "トークンが未入力のため、GitHubには保存していません。";
    return;
  }
  el("ghNote").textContent = "GitHubに保存中…";
  try {
    const url = await github.uploadSession(ghSettings, session);
    el("ghNote").innerHTML = "";
    el("ghNote").append("GitHubに保存しました：", Object.assign(document.createElement("a"), { href: url, target: "_blank", textContent: github.sessionPath(session) }));
  } catch (err) {
    el("ghNote").textContent = `GitHubに保存できませんでした（ブラウザ内には保存済み）：${err.message}`;
  }
}

el("newSession").addEventListener("click", () => {
  if (Object.keys(views).length && !confirm("読み込んでいる動画と解析結果を閉じます。よろしいですか？（保存済みのデータは消えません）")) return;
  clearViews();
  sessionId = null;
  el("sessionDate").value = today();
  el("sessionMemo").value = "";
  setSessionLabel("新規（未保存）");
  selectView("left");
  dataChanged();
});

function clearViews() {
  for (const v of Object.keys(views)) {
    if (views[v].url) URL.revokeObjectURL(views[v].url);
    delete views[v];
  }
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
      body: r.world ? toBodyFrame(r.world) : null,
      strokes: r.strokes,
    };
  }
  sessionId = id;
  el("sessionDate").value = s.date;
  el("sessionMemo").value = s.memo;
  setSessionLabel(`保存済み：${s.date} ${s.memo}`);
  selectView(Object.keys(views)[0] ?? "left");
  dataChanged();
}

async function renderSessions() {
  const body = el("sessionList");
  const a = athletes.currentAthlete(store);
  body.innerHTML = "";
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
    row.innerHTML = `<td>${s.date}</td><td></td><td>${sessions.summarize(s, VIEW_LABELS)}</td>
      <td><button class="btn small">開く</button> <button class="btn small">削除</button></td>`;
    row.children[1].textContent = s.memo; // メモは文字としてそのまま表示
    const [openBtn, deleteBtn] = row.querySelectorAll("button");
    openBtn.addEventListener("click", () => openSession(s.id));
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`${s.date} ${s.memo} を削除しますか？（元に戻せません）`)) return;
      await sessions.deleteSession(s.id);
      if (sessionId === s.id) { sessionId = null; setSessionLabel("新規（未保存）"); }
      renderSessions();
    });
    body.appendChild(row);
  }
  const usage = await sessions.storageUsage();
  el("storageUsage").textContent = usage ? `使用量 ${usage.usedMB} MB / 上限の目安 ${usage.quotaMB} MB` : "";
}

// ================= 骨格推定 =================
// 今の方向の動画を解析する。成功したら true
async function analyzeCurrent() {
  if (!loaded() || analyzing) return false;
  const d = data();
  if (!video.videoWidth) { showStatus(playbackProblem()); return false; }
  let ok = false;
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
      ok = true;
    }
  } catch (err) {
    el("progress").textContent = `解析に失敗しました：${err.message}`;
  }
  analyzing = false;
  setAnalyzing(false);
  dataChanged();
  return ok;
}

el("analyze").addEventListener("click", analyzeCurrent);

// 読み込んだ全方向のうち、未解析の動画を順番に解析する
el("analyzeAll").addEventListener("click", () => {
  if (!unanalyzedViews().length) return alert("未解析の動画がありません（解析済みのものはそのまま使います）");
  analyzeAllViews();
});

const unanalyzedViews = () => Object.keys(VIEW_LABELS).filter((v) => views[v]?.url && !views[v].pose);

// 未解析の動画を順番に解析する。全部できたら true（中止・失敗したらそこで止めて false）
async function analyzeAllViews(onStep = () => {}) {
  const targets = unanalyzedViews();
  for (const [n, v] of targets.entries()) {
    onStep(`${VIEW_LABELS[v]}を解析中（${n + 1} / ${targets.length}）`);
    selectView(v);
    await waitForVideo();
    if (!(await analyzeCurrent())) return false;
  }
  return true;
}

// ================= まとめて実行：解析 → 3Dモデル → 保存 =================
el("runAll").addEventListener("click", async () => {
  if (analyzing) return;
  const status = (text) => (el("runAllStatus").textContent = text);
  if (!athletes.currentAthlete(store)) return status("先に選手を追加・選択してください（保存先になります）");
  if (!Object.values(views).some((d) => d.url)) return status("動画が読み込まれていません。各方向のタブで動画を選択してください");

  el("runAll").disabled = true;
  const skipped = Object.keys(views).filter((v) => views[v].pose).map((v) => VIEW_LABELS[v]);
  const note = skipped.length ? `（解析済みの ${skipped.join("・")} はそのまま使います）` : "";

  // 1. 解析
  const analyzed = await analyzeAllViews((step) => status(`1/3 ${step} ${note}`));
  if (!analyzed) {
    el("runAll").disabled = false;
    return status("解析を中止したか、失敗しました。ここまでの結果は保存していません。");
  }

  // 2. 3Dモデル（解析の終わりに作り直し済み。ここでは結果を確認）
  refreshFusion();
  if (!fused?.right && !fused?.left) {
    el("runAll").disabled = false;
    return status("2/3 3Dモデルを作れませんでした（ストロークが検出できていない可能性）。ストローク表を確認してください。保存はしていません。");
  }
  document.querySelector("input[name=mode3d][value=fused]").checked = true;

  // 3. 保存
  status("3/3 保存中…");
  const saved = await saveCurrentSession();
  el("runAll").disabled = false;
  status(saved
    ? `完了：解析・3Dモデル作成・保存が終わりました。${el("fusionInfo").textContent}`
    : "3/3 保存できませんでした。セッション欄のメッセージを確認してください。");
  updateDisplay();
});

// 動画の表示準備ができるまで待つ
function waitForVideo() {
  return new Promise((resolve) => {
    if (video.readyState >= 2) return resolve();
    video.addEventListener("loadeddata", resolve, { once: true });
    video.addEventListener("error", resolve, { once: true });
  });
}

el("stop").addEventListener("click", () => (stopRequested = true));
el("showSkeleton").addEventListener("change", updateDisplay);

function setAnalyzing(on) {
  el("analyze").disabled = on;
  el("analyzeAll").disabled = on;
  el("saveSession").disabled = on;
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
  dataChanged();
});

el("addStroke").addEventListener("click", () => {
  const d = data();
  if (!loaded()) return;
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
      dataChanged();
    });
    row.querySelector("td:last-child button").addEventListener("click", () => {
      strokes.splice(n, 1);
      dataChanged();
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
    dataChanged();
  } catch (err) {
    alert(`読み込めませんでした：${err.message}`);
  }
});

// ================= 統合3Dモデル（全方向の代表ストローク） =================
// fused：{ right: { frames, views, strokes }, left: ... }（推定値）
let fused = null;

// 解析結果・ストロークが変わったら呼ぶ（統合モデルとコメントを作り直し、表示を更新）
function dataChanged() {
  refreshFusion();
  renderStrokes();
  updateDisplay();
}

function refreshFusion() {
  const usable = Object.entries(views).filter(([v, d]) => d?.body && d.strokes.length > 1 && el(`fuse-${v}`).checked);
  const reps = Object.fromEntries(usable.map(([v, d]) => [v, viewRepresentative(d)]));
  fused = usable.length ? fuseViews(reps) : null;

  const describe = (side, label) => {
    const f = fused?.[side];
    if (!f) return `${label}：データなし`;
    return `${label}：` + Object.entries(f.strokes).map(([v, n]) => `${VIEW_LABELS[v]}${n}本`).join("・");
  };
  el("fusionInfo").textContent = fused
    ? `統合に使ったストローク（代表ストロークの平均）… ${describe("right", "右漕ぎ")}／${describe("left", "左漕ぎ")}`
    : "解析済みの動画がありません。";
  renderFeedback(usable.map(([, d]) => d));
}

Object.keys(VIEW_LABELS).forEach((v) => el(`fuse-${v}`).addEventListener("change", dataChanged));
document.querySelectorAll("input[name=mode3d]").forEach((r) => r.addEventListener("change", updateDisplay));

// ================= フォームのコメント（改善候補） =================
const SIDE_LABEL = { right: "右漕ぎ", left: "左漕ぎ", all: "全体" };

function renderFeedback(usedViews) {
  const body = el("feedbackList");
  body.innerHTML = "";
  if (!fused) return;
  for (const row of buildFeedback(fused, usedViews)) {
    const tr = document.createElement("tr");
    const value = Object.entries(row.values)
      .map(([side, v]) => `${SIDE_LABEL[side]} ${v == null ? "--" : `${v.toFixed(1)}${row.unit}`}`)
      .join("<br>");
    const flagged = row.flagged.length > 0;
    tr.innerHTML = `<td>${row.label}${row.extra ? `<br><span class="muted">${row.extra}</span>` : ""}</td>
      <td>${value}</td>
      <td>${flagged ? `<span class="flag">改善候補（${row.flagged.map((s) => SIDE_LABEL[s]).join("・")}）</span><br>${row.comment}` : '<span class="muted">目安の範囲内</span>'}</td>`;
    body.appendChild(tr);
  }
}

// ================= 3Dビュー =================
setupView3d(el("view3d"));
document.querySelectorAll("[data-view3d]").forEach((b) => {
  b.addEventListener("click", () => setFixedView(b.dataset.view3d));
});
el("showTrails").addEventListener("change", updateDisplay);

// 3Dビューに渡す内容（現在フレームの骨格・パドル、現在のストロークの軌跡）
function update3d(d, frame) {
  const size = paddleSize();
  const mode = document.querySelector("input[name=mode3d]:checked").value;
  let body = null;
  let range = [];

  if (mode === "fused") {
    // 統合モデル：今の動画のフレームがストロークの何%かを求め、代表ストロークのその位相を表示
    const ph = d ? phaseAt(frame, d.strokes) : null;
    const rep = ph && fused?.[ph.side];
    body = rep?.frames[ph.index] ?? null;
    if (body) range = rep.frames.slice(0, ph.index + 1);
    el("mode3dInfo").textContent = !fused ? "統合モデルはまだありません（解析すると作られます）"
      : !ph ? "ストロークの区間外です"
      : !rep ? `この${{ left: "左", right: "右" }[ph.side] ?? "不明な側の"}漕ぎストロークの統合データがありません`
      : `統合モデル：${SIDE_LABEL[ph.side]} ${ph.index}%（${rep.views.map((v) => VIEW_LABELS[v]).join("・")}の代表ストローク）`;
  } else {
    body = d?.body?.[frame] ?? null;
    const n = d ? strokeIndexAt(frame, d.strokes) : -1;
    if (body && n >= 0) range = d.body.slice(d.strokes[n].frame, frame + 1);
    el("mode3dInfo").textContent = d ? `この動画（${VIEW_LABELS[currentView]}）だけの推定` : "";
  }

  const paddle = estimatePaddle(body, size);
  const trails = [];
  if (body && range.length && el("showTrails").checked) {
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
