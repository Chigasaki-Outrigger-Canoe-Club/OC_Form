// 解析結果をGitHubのリポジトリに保存する（GitHub REST API の contents を使用）
// - 保存先：settings.branch（初期値 "data"）。サイト本体の main とは分ける
//   （保存のたびにサイトが作り直されないように、またコードの更新とぶつからないように）
// - 保存するもの：セッションの解析結果（JSON）、選手データ（data/athletes.json）、小さくした動画（compress.js、1本 約5〜8MB）
// - 認証：利用者が発行した Fine-grained personal access token（このリポジトリの Contents 読み書きのみ）
//   トークンはこのブラウザの localStorage にだけ保存する
// 注意：リポジトリが公開の場合、保存したデータは誰でも見られる

import { buildSessionFile } from "./sessions.js";

// ブラウザに保存する設定の名前（解析ページと選手比較ページで共通）
export const SETTINGS_KEY = "oc-form-github";

export const DEFAULT_SETTINGS = {
  owner: "chigasaki-outrigger-canoe-club",
  repo: "OC_Form",
  branch: "data",
  token: "", // トークンが入っていれば直接 GitHub に送る。空なら Worker（r2Url）経由で送る（トークンは Worker にある）
  r2Url: "https://oc-form-video.manato-inokuchi.workers.dev", // 動画の保存先（R2）と GitHub への保存を受け持つ Worker
  raw: false, // true なら全フレームのデータも送る（既定は平均の3Dモデルとストロークだけ）
};

// ブラウザに保存した設定を読む（なければ既定。Worker の URL が空なら既定の Worker を使う）
export function loadSettings(storage) {
  let saved = {};
  try { saved = JSON.parse(storage.getItem(SETTINGS_KEY)) ?? {}; } catch { /* 保存なし・読めない環境 */ }
  return { ...DEFAULT_SETTINGS, ...saved, r2Url: saved.r2Url || DEFAULT_SETTINGS.r2Url };
}

// ---------- 計算・変換（テスト可能） ----------

// ファイル名に使えない文字を置き換える
const safeName = (text) => (text || "unknown").replace(/[\\/:*?"<>|\s]+/g, "_");

// 保存先のパス：data/選手名/練習日_セッションID.json
export const sessionPath = (session) => `data/${safeName(session.athleteName)}/${safeName(session.date)}_${session.id}.json`;

// 文字列（日本語を含む）またはバイト列 → Base64（大きなデータでも止まらないよう分けて変換）
export function toBase64(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ---------- GitHub API ----------
// fetchFn はテストで差し替えられるように引数にしている

function client(settings, fetchFn = fetch) {
  const base = `https://api.github.com/repos/${settings.owner}/${settings.repo}`;
  return async (path, options = {}) => {
    const res = await fetchFn(`${base}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${settings.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(`GitHub ${res.status}：${detail.message ?? "エラー"}`);
    }
    return res.json();
  };
}

// 接続の確認：リポジトリが見えて、書き込み権限があるか
export async function testConnection(settings, fetchFn) {
  const api = client(settings, fetchFn);
  const repo = await api("");
  if (!repo) throw new Error("リポジトリが見つかりません（名前かトークンの対象リポジトリを確認してください）");
  if (repo.permissions && !repo.permissions.push) throw new Error("このトークンには書き込み権限がありません（Contents を Read and write にしてください）");
  return { private: repo.private, defaultBranch: repo.default_branch };
}

// 保存用ブランチがなければ、既定ブランチの最新から作る
async function ensureBranch(api, settings) {
  if (await api(`/branches/${settings.branch}`)) return;
  const repo = await api("");
  const ref = await api(`/git/ref/heads/${repo.default_branch}`);
  await api("/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${settings.branch}`, sha: ref.object.sha }) });
}

// 保存済みデータの一覧（公開リポジトリならトークン不要）。新しい順
// 戻り値：[{ path, athlete, name }]（保存用ブランチがなければ空）
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

// 保存データのファイルを直接読むURL
export const rawUrl = (settings, path) =>
  `https://raw.githubusercontent.com/${settings.owner}/${settings.repo}/${settings.branch}/${path.split("/").map(encodeURIComponent).join("/")}`;

// ファイルを保存（同じファイルがあれば上書き）。content：文字列かバイト列。戻り値：GitHub上のURL
async function putFile(settings, path, content, message, fetchFn = fetch) {
  if (!settings.token) return putViaWorker(settings, path, content, message, fetchFn);
  const api = client(settings, fetchFn);
  await ensureBranch(api, settings);
  const urlPath = `/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const existing = await api(`${urlPath}?ref=${settings.branch}`);
  const result = await api(urlPath, {
    method: "PUT",
    body: JSON.stringify({ message, content: toBase64(content), branch: settings.branch, ...(existing?.sha ? { sha: existing.sha } : {}) }),
  });
  return result.content.html_url;
}

// Worker 経由で保存（トークンは Worker の Secret にあり、サイトは保存用の合言葉だけを送る）
async function putViaWorker(settings, path, content, message, fetchFn) {
  if (!settings.r2Url) throw new Error("保存先がありません（トークンか Worker の URL が必要です）");
  const res = await fetchFn(`${settings.r2Url.replace(/\/+$/, "")}/github/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT", body: content, headers: { "X-Upload-Key": settings.r2Upload || "", "X-Message": encodeURIComponent(message) },
  });
  if (!res.ok) throw new Error(`Worker ${res.status}：${await res.text()}`);
  return (await res.json()).url;
}

// 保存できる設定か（トークン、または Worker の URL と保存用の合言葉）
export const canSave = (settings) => Boolean(settings.token || (settings.r2Url && settings.r2Upload));

// セッションを保存
export function uploadSession(settings, session, fetchFn) {
  const message = `解析結果を保存：${session.athleteName ?? ""} ${session.date ?? ""} ${session.memo ?? ""}`.trim();
  return putFile(settings, sessionPath(session), JSON.stringify(buildSessionFile(session, { raw: settings.raw })), message, fetchFn);
}

// 小さくした動画を保存。保存先：data/選手名/練習日_セッションID_方向.mp4。戻り値：パス
export const videoPath = (session, view) => sessionPath(session).replace(/\.json$/, `_${view}.mp4`);
export async function uploadVideo(settings, session, view, blob, fetchFn) {
  const path = videoPath(session, view);
  await putFile(settings, path, new Uint8Array(await blob.arrayBuffer()), `動画を保存：${session.athleteName ?? ""} ${session.date ?? ""} ${view}`, fetchFn);
  return path;
}

// 選手データ（全員の名前・身長・体重・パドル寸法）を保存
export const ATHLETES_PATH = "data/athletes.json";
export function uploadAthletes(settings, backup, fetchFn) {
  return putFile(settings, ATHLETES_PATH, JSON.stringify(backup, null, 1), "選手データを保存", fetchFn);
}
