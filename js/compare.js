// 選手を並べて比べる：保存したデータ（Cloudflare）の動画に骨格の点を重ね、ストロークの同じ位置でそろえて並べる
//
// そろえ方：
//   各動画から、漕ぐ側（右漕ぎ・左漕ぎ）の代表のストローク（長さが中央値に近いもの）を1本選び、その1本を繰り返し再生する
//   全員の1ストロークが同じ時間 T で終わるように、動画ごとに再生速度を変える（速度＝その人のストロークの長さ ÷ T）
//   → 同じ瞬間には、全員がストロークの同じ位置（キャッチからの何%か）にいる
// 並べる数：PCは4人（上下左右の4分割）、スマホ（画面の幅が狭いとき）は2人（上下の2分割。CSS で3・4人目を隠す）

import { fetchVideo, listSessions, readText } from "./r2.js";
import { parseSessionFile } from "./sessions.js";
import { representative } from "./assist.js";
import { drawSkeleton } from "./overlay.js";

const VIEWS = { front: "前", left: "左", right: "右", back: "後ろ" };
const CELLS = 4;
const el = (id) => document.getElementById(id);

let settings = null;
let list = [];          // 保存したデータ [{ path, athlete, name, source }]
const cells = [];       // 並べる枠 { box, select, video, canvas, label, data, stroke }
const clock = { playing: false, start: 0, phase: 0, period: 1.2 }; // 共通の時計（phase＝0〜1）

// 1つの枠のデータを読む：保存した解析結果 → 選んだ方向の骨格・ストローク → 動画
async function load(cell, path) {
  cell.data = null;
  cell.label.textContent = path ? "読み込み中…" : "";
  cell.video.removeAttribute("src");
  if (!path) return update();
  try {
    const text = await readText(settings, path); // Cloudflare → なければ前に GitHub へ保存したもの
    if (!text) throw new Error("データを読めません");
    const s = parseSessionFile(text);
    // 選んだ方向がなければ、動画と骨格がある方向を使う（並べる人で撮った方向が違うことがあるため）
    const usable = (v) => s.views[v]?.pose && (s.views[v].video?.github || s.views[v].video?.r2);
    const view = usable(el("compareView").value) ? el("compareView").value : Object.keys(VIEWS).find(usable);
    if (!view) throw new Error("動画か骨格が保存されていません");
    const r = s.views[view];
    const file = await fetchVideo(settings, r.video); // R2 → GitHub の順に探す
    if (!file) throw new Error("動画を読めません（R2 の場合は再生用の合言葉を確認してください）");
    cell.video.src = URL.createObjectURL(file);
    cell.canvas.width = r.video.width ?? 1280;  // 骨格の点は元の動画のピクセル座標
    cell.canvas.height = r.video.height ?? 720;
    cell.data = { pose: r.pose, strokes: r.strokes, fps: r.video.fps, title: `${s.athleteName ?? ""} ${s.date ?? ""} ${VIEWS[view]}から ${s.memo ?? ""}` };
  } catch (err) {
    cell.label.textContent = `読み込めません：${err.message}`;
  }
  update();
}

// 漕ぐ側を変えたら、代表のストロークと共通の周期を決め直す
function update() {
  const side = document.querySelector("input[name=compareSide]:checked").value;
  for (const cell of cells) {
    const d = cell.data;
    if (!d) { cell.stroke = null; continue; }
    // 選んだ漕ぐ側がなければ、反対側の代表ストロークを使う（その旨を名前の横に出す）
    const other = side === "right" ? "left" : "right";
    const own = representative(d.strokes, side);
    const n = own ?? representative(d.strokes, other);
    cell.stroke = n == null ? null : { start: d.strokes[n].frame / d.fps, length: (d.strokes[n + 1].frame - d.strokes[n].frame) / d.fps };
    const note = n == null ? "（ストロークがありません）" : own == null ? `（${other === "right" ? "右" : "左"}漕ぎ）` : "";
    cell.label.textContent = d.title + note;
  }
  const lengths = cells.map((c) => c.stroke?.length).filter(Boolean);
  const speed = Number(el("compareSpeed").value);
  clock.period = (lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 1.2) / speed;
  seekAll();
}

// 共通の位置（phase）に全員を合わせる
function seekAll() {
  for (const cell of cells) {
    if (!cell.stroke) continue;
    cell.video.currentTime = cell.stroke.start + clock.phase * cell.stroke.length;
  }
  el("comparePhase").value = Math.round(clock.phase * 100);
  draw();
}

// 再生：共通の時計で位置を進め、各動画の速度を合わせる。ずれたら合わせ直す
function tick(now) {
  if (!clock.playing) return;
  clock.phase = (((now - clock.start) / 1000) / clock.period) % 1;
  for (const cell of cells) {
    if (!cell.stroke) continue;
    const target = cell.stroke.start + clock.phase * cell.stroke.length;
    cell.video.playbackRate = Math.min(16, Math.max(0.0625, cell.stroke.length / clock.period));
    if (cell.video.paused) cell.video.play().catch(() => {});
    if (Math.abs(cell.video.currentTime - target) > 0.12) cell.video.currentTime = target; // 次のストロークへ入ったら、頭に戻す
  }
  el("comparePhase").value = Math.round(clock.phase * 100);
  draw();
  requestAnimationFrame(tick);
}

function draw() {
  for (const cell of cells) {
    const d = cell.data;
    const frame = d ? Math.floor(cell.video.currentTime * d.fps) : -1;
    drawSkeleton(cell.canvas, d?.pose?.[frame] ?? null);
  }
}

function setPlaying(on) {
  clock.playing = on;
  el("comparePlay").textContent = on ? "⏸ 停止" : "▶ 再生";
  if (on) {
    clock.start = performance.now() - clock.phase * clock.period * 1000;
    requestAnimationFrame(tick);
  } else {
    cells.forEach((c) => c.video.pause());
    seekAll();
  }
}

// 一覧を作り直す（保存したデータ）
function fillSelects() {
  for (const cell of cells) {
    const current = cell.select.value;
    cell.select.innerHTML = '<option value="">（選ぶ）</option>';
    for (const item of list) cell.select.add(new Option(`${item.athlete}　${item.name}`, item.path, false, item.path === current));
  }
}

export async function setupCompare(ghSettings) {
  settings = ghSettings;
  const grid = el("compareGrid");
  for (let k = 0; k < CELLS; k++) {
    const wrap = Object.assign(document.createElement("div"), { className: "compare-cell" });
    wrap.innerHTML = `<select class="btn" aria-label="${k + 1}人目"></select><div class="stage"><video playsinline muted></video><canvas></canvas></div><p class="muted small"></p>`;
    grid.appendChild(wrap);
    const cell = { box: wrap.querySelector(".stage"), select: wrap.querySelector("select"), video: wrap.querySelector("video"), canvas: wrap.querySelector("canvas"), label: wrap.querySelector("p"), data: null, stroke: null };
    cell.select.addEventListener("change", () => load(cell, cell.select.value));
    cell.video.addEventListener("seeked", draw);
    cell.video.addEventListener("loadeddata", seekAll); // 読み込みが終わってから位置を合わせる（先に合わせると黒い画面のまま）
    cells.push(cell);
  }
  el("compareView").addEventListener("change", () => cells.forEach((c) => load(c, c.select.value)));
  document.querySelectorAll("input[name=compareSide]").forEach((r) => r.addEventListener("change", update));
  el("compareSpeed").addEventListener("change", () => { update(); if (clock.playing) setPlaying(true); });
  el("comparePlay").addEventListener("click", () => setPlaying(!clock.playing));
  el("comparePhase").addEventListener("input", (e) => { setPlaying(false); clock.phase = Number(e.target.value) / 100; seekAll(); });
  try {
    list = await listSessions(settings);
  } catch {
    list = [];
  }
  fillSelects();
}
