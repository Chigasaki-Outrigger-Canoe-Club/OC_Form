// セッション（1回の練習の解析結果）をブラウザ内（IndexedDB）に保存する
// - "sessions" ストア：解析結果（骨格・ストロークなど）。一覧表示に使う
// - "videos" ストア：動画ファイル（任意）。キー＝"セッションID:方向"。大きいので別に保存
// 動画・データはこのPCのブラウザ内だけに保存され、外部には送信しない。

const DB_NAME = "oc-form";
const DB_VERSION = 1;

// ---------- 保存形式への変換（画面から分離、テスト可能） ----------

// 1方向分のデータ → 保存する形（動画本体・表示用の値は除く）
export function viewToRecord(d) {
  return {
    video: {
      name: d.name, fps: d.fps, fpsSource: d.fpsSource, codec: d.codec ?? null, size: d.file?.size ?? null,
      width: d.width ?? null, height: d.height ?? null, // 元の動画の大きさ（骨格の点のピクセル座標の基準）
      github: d.githubVideo ?? null,                   // GitHubに保存した小さい動画のパス（なければ null）
      r2: d.r2Video ?? null,                           // Cloudflare R2 に保存した小さい動画のパス（なければ null）
    },
    pose: d.pose ?? null,
    world: d.world ?? null,
    spine: d.spine ?? null,
    hands: d.hands ?? null,
    shaft: d.shaft ?? null,
    truth: d.truth ?? null, // 人が付けた正解（評価用）：{ フレーム: { 関節番号: { x, y } } }（ピクセル）
    strokes: d.strokes ?? [],
  };
}

// 画面の全方向 → セッションの記録
// model：全方向を合わせた代表ストローク（漕ぐ側ごとの平均。3Dで繰り返し再生する）
export function buildSession({ id, athlete, date, memo, views, model = null, now = new Date() }) {
  const recorded = Object.fromEntries(Object.entries(views).filter(([, d]) => d).map(([view, d]) => [view, viewToRecord(d)]));
  return {
    id: id ?? `s${now.getTime().toString(36)}`,
    athleteId: athlete?.id ?? null,
    athleteName: athlete?.name ?? null,
    athleteValues: athlete?.values ?? null,
    date,
    memo,
    savedAt: now.toISOString(),
    model,
    views: recorded,
  };
}

// 新しい順（練習日 → 保存日時）
export const sortSessions = (list) => [...list].sort((a, b) =>
  (b.date ?? "").localeCompare(a.date ?? "") || b.savedAt.localeCompare(a.savedAt));

// ---------- ファイル（書き出し・読み込み・GitHub保存）の形式 ----------

// 書き出す中身（セッションの記録に形式名と説明を付ける）。動画は含まない
// raw が false なら、3D推定などの全フレームのデータ（world・spine・hands・shaft）を省き、平均の3Dモデル・ストローク・2Dの骨格だけにする
export function buildSessionFile(session, { raw = false } = {}) {
  // 既定でも2Dの骨格（pose）は入れる：選手を並べて比べるとき、動画に点を重ねるため（1方向 約1MB）
  const views = raw ? session.views : Object.fromEntries(Object.entries(session.views).map(([v, r]) => [v, { video: r.video, strokes: r.strokes, truth: r.truth ?? null, pose: r.pose ?? null }]));
  return {
    format: "oc-form-session",
    version: 1,
    notes: {
      contents: raw ? "解析結果（全フレーム）と平均の3Dモデル。動画は別ファイル" : "平均の3Dモデル（model）、ストロークの区切り、2Dの骨格（pose）。3D推定などの全フレームのデータは含まない。動画は別ファイル",
      model: "漕ぐ側ごとの代表ストローク（0〜100%の101点）。選手基準の3D座標（X左・Y上・Z前、単位およそm）。spine＝背中の膨らみ、duration＝平均ストローク時間（秒）",
      pose: "画像上のピクセル座標（左上が原点、yは下向き）。v＝MediaPipeの信頼度（0〜1）。src：est＝推定値、manual＝手動修正（ox・oy＝直す前の推定の位置）",
      shaft: "画像から見つけた木のシャフト（前・後ろの動画）。フレームごとに { dir: 画像上の向き（下向き）, point: 線の上の1点（ピクセル）, s: 確かさ }",
      truth: "人が付けた正解（評価用）。{ フレーム番号: { 関節番号: { x, y } } }（ピクセル座標）",
      hands: "手の専用推定（Hand Landmarker）。フレームごとに [{ s: 信頼度, p: [手首, 小指の付け根, 人差し指の付け根] }]（ピクセル座標）",
      world: "MediaPipeの3D推定座標（腰の中心が原点、単位およそm、x右・y下・z奥）。1台のカメラからの推定値",
      strokes: "区切り＝キャッチ（力を入れ始める位置。自動推定または手動設定）。side＝そのストロークの漕ぐ側",
    },
    ...session,
    views,
  };
}

// 読み込んだファイル → セッションの記録（形式が違えば例外）
export function parseSessionFile(text) {
  const json = JSON.parse(text);
  if (json.format !== "oc-form-session" || !json.id || typeof json.views !== "object") {
    throw new Error("このシステムで書き出したデータではありません");
  }
  const { format, version, notes, ...session } = json;
  return session;
}

// ---------- IndexedDB の読み書き ----------

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("sessions", { keyPath: "id" }).createIndex("athleteId", "athleteId");
      db.createObjectStore("videos");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 1回の読み書き（stores：使うストア名、work：tx を受け取り結果を返す関数）
async function run(stores, mode, work) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    const req = work(tx);
    if (req) req.onsuccess = () => (result = req.result);
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("保存できませんでした（容量不足の可能性）")); };
  });
}

// 保存。videos：{ 方向: Blob }（動画を保存しない場合は空）
export function saveSession(session, videos) {
  return run(["sessions", "videos"], "readwrite", (tx) => {
    tx.objectStore("sessions").put(session);
    const store = tx.objectStore("videos");
    for (const view of Object.keys(session.views)) {
      const key = `${session.id}:${view}`;
      if (videos[view]) store.put(videos[view], key);
    }
  });
}

export function listSessions(athleteId) {
  return run(["sessions"], "readonly", (tx) => tx.objectStore("sessions").index("athleteId").getAll(athleteId));
}

export function getSession(id) {
  return run(["sessions"], "readonly", (tx) => tx.objectStore("sessions").get(id));
}

export function getVideo(sessionId, view) {
  return run(["videos"], "readonly", (tx) => tx.objectStore("videos").get(`${sessionId}:${view}`));
}

export function deleteSession(id) {
  return run(["sessions", "videos"], "readwrite", (tx) => {
    tx.objectStore("sessions").delete(id);
    tx.objectStore("videos").delete(IDBKeyRange.bound(`${id}:`, `${id}:￿`));
  });
}

// 使用量の表示用（MB）。対応していないブラウザは null
export async function storageUsage() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usedMB: Math.round(usage / 1e6), quotaMB: Math.round(quota / 1e6) };
}

// ブラウザが容量不足のときに自動で消さないよう依頼する（許可されない場合もある）
export async function requestPersist() {
  return navigator.storage?.persist ? navigator.storage.persist() : false;
}
