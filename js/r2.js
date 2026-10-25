// データの保存場所（Cloudflare R2）とのやりとり。R2 の前に立つ Worker（tools/r2-worker/worker.js）を通す
// 役割の分担：Cloudflare＝解析結果・選手データ・動画の保存、GitHub＝サイトの表示だけ
//   （前に GitHub の data ブランチへ保存したデータは読むだけ。migrateFromGitHub で Cloudflare へ移せる）
// 設定（このブラウザに保存）：r2Url＝Worker の URL、r2Upload＝保存用の合言葉、r2View＝見る用の合言葉（ふだんは不要）
// 保存先のパスは data/選手名/練習日_ID.json・data/選手名/練習日_ID_方向.mp4・data/athletes.json

import * as github from "./github.js";
import { buildSessionFile } from "./sessions.js";

const base = (settings) => (settings.r2Url || "").replace(/\/+$/, "");
const encode = (path) => path.split("/").map(encodeURIComponent).join("/");
const fileUrl = (settings, path) => `${base(settings)}/files/${encode(path)}`;
export const useR2 = (settings) => Boolean(base(settings));
export const canSave = (settings) => Boolean(base(settings) && settings.r2Upload);
// 合言葉のヘッダー。保存用の合言葉でも見られる（Worker が受け付ける）ので、保存する人は合言葉1つでよい
const keyHeaders = (settings) => ({ "X-Upload-Key": settings.r2Upload || "", "X-View-Key": settings.r2View || "" });
export const ATHLETES_PATH = "data/athletes.json";

// 合言葉の確認 → { upload, view }
export async function checkR2(settings, fetchFn = fetch) {
  const res = await fetchFn(`${base(settings)}/check`, { headers: keyHeaders(settings) });
  if (!res.ok) throw new Error(`Worker に届きません（${res.status}）`);
  return res.json();
}

// ファイルを保存（同じパスは上書き）。戻り値：パス
async function putFile(settings, path, body, type, fetchFn = fetch) {
  const res = await fetchFn(fileUrl(settings, path), { method: "PUT", body, headers: { "Content-Type": type, "X-Upload-Key": settings.r2Upload || "" } });
  if (!res.ok) throw new Error(`Cloudflare に保存できません（${res.status}：${await res.text()}）`);
  return path;
}

export const uploadVideoR2 = (settings, session, view, blob, fetchFn) => putFile(settings, github.videoPath(session, view), blob, "video/mp4", fetchFn);
export const uploadSession = (settings, session, fetchFn) =>
  putFile(settings, github.sessionPath(session), JSON.stringify(buildSessionFile(session, { raw: settings.raw })), "application/json", fetchFn);
export const uploadAthletes = (settings, backup, fetchFn) => putFile(settings, ATHLETES_PATH, JSON.stringify(backup, null, 1), "application/json", fetchFn);

// 保存した解析結果の一覧（新しい順）[{ path, athlete, name, source: "r2"|"github" }]
//   Cloudflare のものを優先し、前に GitHub へ保存したものも（同じパスがなければ）並べる
const SESSION_PATH = /^data\/[^/]+\/[^/]+\.json$/;
const toItem = (path, source) => { const [, athlete, file] = path.split("/"); return { path, athlete, name: file.replace(/\.json$/, ""), source }; };
export async function listSessions(settings, fetchFn = fetch) {
  const items = [];
  if (useR2(settings)) {
    try {
      const res = await fetchFn(`${base(settings)}/list?prefix=data/`, { headers: keyHeaders(settings) });
      if (res.ok) items.push(...(await res.json()).map((o) => o.key).filter((k) => SESSION_PATH.test(k)).map((k) => toItem(k, "r2")));
    } catch { /* Cloudflare に届かなくても、GitHub の古いデータは並べる */ }
  }
  const old = await github.listSavedSessions(settings, fetchFn).catch(() => []);
  items.push(...old.filter((o) => !items.some((x) => x.path === o.path)).map((o) => ({ ...o, source: "github" })));
  return items.sort((a, b) => b.name.localeCompare(a.name));
}

// ファイルを文字列で読む（Cloudflare → なければ GitHub）。読めなければ null
export async function readText(settings, path, fetchFn = fetch) {
  for (const url of [useR2(settings) && fileUrl(settings, path), github.rawUrl(settings, path)].filter(Boolean)) {
    try {
      const res = await fetchFn(url, { headers: url.startsWith("https://raw.") ? {} : keyHeaders(settings), cache: "no-store" });
      if (res.ok) return await res.text();
    } catch { /* 次の場所を試す */ }
  }
  return null;
}

// 保存した動画を読む（Cloudflare → なければ GitHub）。読めなければ null
export async function fetchVideo(settings, meta, fetchFn = fetch) {
  const tries = [meta?.r2 && useR2(settings) && [fileUrl(settings, meta.r2), keyHeaders(settings)], meta?.github && [github.rawUrl(settings, meta.github), {}]].filter(Boolean);
  for (const [url, headers] of tries) {
    try {
      const res = await fetchFn(url, { headers });
      if (res.ok) return new File([await res.blob()], url.split("/").pop(), { type: "video/mp4" });
    } catch { /* 次の場所を試す */ }
  }
  return null;
}

// 前に GitHub の data ブランチへ保存したデータを Cloudflare へ移す（同じパスが Cloudflare にあれば飛ばす）
//   解析結果の JSON は、動画の場所（video.r2）を書き足してから保存する。戻り値：移したファイル数
export async function migrateFromGitHub(settings, onProgress = () => {}, fetchFn = fetch) {
  const res = await fetchFn(`https://api.github.com/repos/${settings.owner}/${settings.repo}/git/trees/${settings.branch}?recursive=1`);
  if (!res.ok) throw new Error(`GitHub の一覧を読めません（${res.status}）`);
  const files = (await res.json()).tree.filter((t) => t.type === "blob" && t.path.startsWith("data/")).map((t) => t.path);
  const listRes = await fetchFn(`${base(settings)}/list?prefix=data/`, { headers: keyHeaders(settings) });
  const have = new Set(listRes.ok ? (await listRes.json()).map((o) => o.key) : []);
  let moved = 0;
  for (const [n, path] of files.entries()) {
    onProgress(n + 1, files.length, path);
    if (have.has(path)) continue;
    const file = await fetchFn(github.rawUrl(settings, path));
    if (!file.ok) continue;
    if (path.endsWith(".json")) {
      const data = JSON.parse(await file.text());
      for (const v of Object.values(data.views ?? {})) if (v?.video?.github && !v.video.r2) v.video.r2 = v.video.github;
      await putFile(settings, path, JSON.stringify(data), "application/json", fetchFn);
    } else {
      await putFile(settings, path, await file.blob(), path.endsWith(".mp4") ? "video/mp4" : "application/octet-stream", fetchFn);
    }
    moved++;
  }
  return moved;
}
