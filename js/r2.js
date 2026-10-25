// 動画の保存場所（Cloudflare R2）とのやりとり。R2 の前に立つ Worker（tools/r2-worker/worker.js）に送る
// 設定（このブラウザに保存）：r2Url＝Worker の URL、r2Upload＝保存用の合言葉、r2View＝再生用の合言葉
// R2 の URL が入っていなければ、これまでどおり GitHub に動画を置く

import * as github from "./github.js";

const base = (settings) => (settings.r2Url || "").replace(/\/+$/, "");
const encode = (path) => path.split("/").map(encodeURIComponent).join("/");
export const useR2 = (settings) => Boolean(base(settings));
// 合言葉のヘッダー。保存用の合言葉でも再生できる（Worker が受け付ける）ので、保存する人は合言葉1つでよい
const keyHeaders = (settings) => ({ "X-Upload-Key": settings.r2Upload || "", "X-View-Key": settings.r2View || "" });

// 合言葉の確認 → { upload, view }
export async function checkR2(settings, fetchFn = fetch) {
  const res = await fetchFn(`${base(settings)}/check`, { headers: keyHeaders(settings) });
  if (!res.ok) throw new Error(`Worker に届きません（${res.status}）`);
  return res.json();
}

// 動画を保存。戻り値：保存先のパス（data/選手名/練習日_ID_方向.mp4。GitHub と同じ形）
export async function uploadVideoR2(settings, session, view, blob, fetchFn = fetch) {
  const path = github.videoPath(session, view);
  const res = await fetchFn(`${base(settings)}/videos/${encode(path)}`, {
    method: "PUT", body: blob, headers: { "Content-Type": "video/mp4", "X-Upload-Key": settings.r2Upload || "" },
  });
  if (!res.ok) throw new Error(`R2 に保存できません（${res.status}：${await res.text()}）`);
  return path;
}

// 保存した動画を読む（R2 → なければ GitHub）。読めなければ null
export async function fetchVideo(settings, meta, fetchFn = fetch) {
  try {
    if (meta?.r2 && useR2(settings)) {
      const res = await fetchFn(`${base(settings)}/videos/${encode(meta.r2)}`, { headers: keyHeaders(settings) });
      if (res.ok) return new File([await res.blob()], meta.r2.split("/").pop(), { type: "video/mp4" });
    }
    if (meta?.github) {
      const res = await fetchFn(github.rawUrl(settings, meta.github));
      if (res.ok) return new File([await res.blob()], meta.github.split("/").pop(), { type: "video/mp4" });
    }
  } catch { /* 読めないときは null */ }
  return null;
}
