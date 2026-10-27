// 保存の設定と保存先のパス。GitHub は「サイトの表示」と、前に data ブランチへ保存したデータを読むだけ
// （10/25 から、解析結果・選手データ・動画の保存は Cloudflare。やりとりは r2.js）
// 注意：リポジトリは公開なので、data ブランチに残っている古いデータは誰でも見られる

// ブラウザに保存する設定の名前（解析ページと選手比較ページで共通）
export const SETTINGS_KEY = "oc-form-github";

export const DEFAULT_SETTINGS = {
  owner: "chigasaki-outrigger-canoe-club",
  repo: "OC_Form",
  branch: "data", // 前に保存したデータのブランチ（読むだけ）
  r2Url: "https://oc-form-video.manato-inokuchi.workers.dev", // データを保存する Cloudflare Worker
  raw: false, // true なら全フレームのデータも保存する（既定は 3Dモデル・ストロークの区切り・2Dの骨格）
};

// ブラウザに保存した設定を読む（なければ既定。Worker の URL が空なら既定の Worker を使う）
export function loadSettings(storage) {
  let saved = {};
  try { saved = JSON.parse(storage.getItem(SETTINGS_KEY)) ?? {}; } catch { /* 保存なし・読めない環境 */ }
  return { ...DEFAULT_SETTINGS, ...saved, r2Url: saved.r2Url || DEFAULT_SETTINGS.r2Url };
}

// ファイル名に使えない文字を置き換える
export const safeName = (text) => (text || "unknown").replace(/[\\/:*?"<>|\s]+/g, "_");

// 保存先のフォルダ名（data/選手名/）がその選手のものか。名前で判断する（大文字・小文字は区別しない）
export const sameAthlete = (folder, name) => folder.toLowerCase() === safeName(name).toLowerCase();

// 保存先のパス：data/選手名/練習日_セッションID.json、動画は …_方向.mp4
export const sessionPath = (session) => `data/${safeName(session.athleteName)}/${safeName(session.date)}_${session.id}.json`;
export const videoPath = (session, view) => sessionPath(session).replace(/\.json$/, `_${view}.mp4`);

// 前に GitHub へ保存したデータの一覧（トークン不要）。新しい順 [{ path, athlete, name }]
export async function listSavedSessions(settings, fetchFn = fetch) {
  const res = await fetchFn(`https://api.github.com/repos/${settings.owner}/${settings.repo}/git/trees/${settings.branch}?recursive=1`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const { tree } = await res.json();
  return tree
    .filter((t) => t.type === "blob" && /^data\/[^/]+\/[^/]+\.json$/.test(t.path))
    .map((t) => {
      const [, athlete, file] = t.path.split("/");
      return { path: t.path, athlete, name: file.replace(/\.json$/, "") };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

// 前に保存したファイルを直接読む URL
export const rawUrl = (settings, path) =>
  `https://raw.githubusercontent.com/${settings.owner}/${settings.repo}/${settings.branch}/${path.split("/").map(encodeURIComponent).join("/")}`;
