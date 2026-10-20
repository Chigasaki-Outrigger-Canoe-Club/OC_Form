// 解析結果をGitHubのリポジトリに保存する（GitHub REST API の contents を使用）
// - 保存先：settings.branch（初期値 "data"）。サイト本体の main とは分ける
//   （保存のたびにサイトが作り直されないように、またコードの更新とぶつからないように）
// - 保存するもの：セッションの解析結果（JSON）。動画は大きすぎるため保存しない
// - 認証：利用者が発行した Fine-grained personal access token（このリポジトリの Contents 読み書きのみ）
//   トークンはこのブラウザの localStorage にだけ保存する
// 注意：リポジトリが公開の場合、保存したデータは誰でも見られる

import { buildSessionFile } from "./sessions.js";

export const DEFAULT_SETTINGS = {
  owner: "chigasaki-outrigger-canoe-club",
  repo: "OC_Form",
  branch: "data",
  token: "",
  enabled: false,
  raw: false, // true なら全フレームのデータも送る（既定は平均の3Dモデルとストロークだけ）
};

// ---------- 計算・変換（テスト可能） ----------

// ファイル名に使えない文字を置き換える
const safeName = (text) => (text || "unknown").replace(/[\\/:*?"<>|\s]+/g, "_");

// 保存先のパス：data/選手名/練習日_セッションID.json
export const sessionPath = (session) => `data/${safeName(session.athleteName)}/${safeName(session.date)}_${session.id}.json`;

// 文字列（日本語を含む）→ Base64（大きなデータでも止まらないよう分けて変換）
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
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

// セッションを保存（同じファイルがあれば上書き）。戻り値：GitHub上のURL
export async function uploadSession(settings, session, fetchFn) {
  const api = client(settings, fetchFn);
  await ensureBranch(api, settings);
  const path = sessionPath(session);
  const urlPath = `/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const existing = await api(`${urlPath}?ref=${settings.branch}`);
  const result = await api(urlPath, {
    method: "PUT",
    body: JSON.stringify({
      message: `解析結果を保存：${session.athleteName ?? ""} ${session.date ?? ""} ${session.memo ?? ""}`.trim(),
      content: toBase64(JSON.stringify(buildSessionFile(session, { raw: settings.raw }))),
      branch: settings.branch,
      ...(existing?.sha ? { sha: existing.sha } : {}),
    }),
  });
  return result.content.html_url;
}
