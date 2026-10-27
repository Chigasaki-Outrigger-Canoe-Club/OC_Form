// データの保存場所（Cloudflare R2）とサイトの間に立つ小さなプログラム（Cloudflare Worker）
//
// 役割の分担：Cloudflare＝データ（解析結果・選手データ・動画）の保存、GitHub＝サイトの表示だけ
// 何のため：R2 の鍵をサイトに置かずに、合言葉を知っている人だけが保存できるようにする
// 使い方（Cloudflare の画面で設定）：
//   - R2 バケットを「VIDEOS」という名前で結び付ける（Bindings → R2 bucket。wrangler.toml にも書いてある）
//   - 合言葉を Secret で入れる：UPLOAD_KEY＝保存用（必須）、VIEW_KEY＝見る用（入れなければ誰でも見られる）
// 受け付けるもの：
//   PUT /files/<保存先>   ヘッダー X-Upload-Key ＝ UPLOAD_KEY → ファイルを保存（解析結果の JSON・動画）
//   GET /files/<保存先>                                     → ファイルを返す
//   GET /list?prefix=data/                                  → 保存したファイルの一覧（JSON）
//   GET /check            ヘッダー X-Upload-Key（任意）       → 合言葉が合っているかの確認
//   GET  /comments/<選手名>                                 → その選手へのコメントの一覧（古い順）
//   POST /comments/<選手名> ヘッダー X-Upload-Key、本文 { name, text } → コメントを1件書き込む（日時は Worker が付ける）
//   /videos/<保存先> は /files/ と同じ（前の版のサイトのため）

const MAX_BYTES = 90 * 1024 * 1024; // 1本の上限（Workers の無料プランは 100MB まで受け取れる）

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Upload-Key, X-View-Key",
};
const reply = (body, status = 200, headers = {}) => new Response(body, { status, headers: { ...cors, ...headers } });
const json = (data) => reply(JSON.stringify(data), 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });

// 保存先の名前：/files/（または /videos/）のあと。「..」や先頭の / は認めない（ほかの場所を指さないように）
function objectKey(pathname) {
  const prefix = ["/files/", "/videos/"].find((p) => pathname.startsWith(p));
  if (!prefix) return null;
  const key = decodeURIComponent(pathname.slice(prefix.length));
  if (!key || key.startsWith("/") || key.split("/").includes("..") || key.length > 300) return null;
  return key;
}

// 一覧（prefix で始まるものすべて。1回で返らない分は続きを読む）
async function listAll(bucket, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor });
    out.push(...page.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

// ---- コメント（掲示板） ----
// 1件ずつ別のファイルにする（同時に書き込んでも消し合わないように）。保存先：comments/選手名/日時_乱数.json
const NAME_MAX = 30;
const TEXT_MAX = 2000;
const commentPrefix = (athlete) => `comments/${athlete}/`;

async function listComments(bucket, athlete) {
  const items = await listAll(bucket, commentPrefix(athlete));
  const list = await Promise.all(items.map(async (o) => (await bucket.get(o.key))?.json()));
  return list.filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));
}

async function postComment(bucket, athlete, body) {
  const name = String(body?.name ?? "").trim().slice(0, NAME_MAX) || "名無し";
  const text = String(body?.text ?? "").trim().slice(0, TEXT_MAX);
  if (!text) return null;
  const at = new Date().toISOString();
  await bucket.put(`${commentPrefix(athlete)}${at}_${Math.random().toString(36).slice(2, 8)}.json`, JSON.stringify({ name, text, at }),
    { httpMetadata: { contentType: "application/json" } });
  return { name, text, at };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return reply(null, 204);
    const url = new URL(request.url);
    const uploadOk = Boolean(env.UPLOAD_KEY) && request.headers.get("X-Upload-Key") === env.UPLOAD_KEY;
    const viewOk = !env.VIEW_KEY || request.headers.get("X-View-Key") === env.VIEW_KEY || uploadOk;

    if (url.pathname === "/check") return json({ upload: uploadOk, view: viewOk });
    if (url.pathname === "/list") {
      if (!viewOk) return reply("見る用の合言葉が違います", 401);
      return json(await listAll(env.VIDEOS, url.searchParams.get("prefix") || "data/"));
    }

    if (url.pathname.startsWith("/comments/")) {
      const athlete = decodeURIComponent(url.pathname.slice("/comments/".length));
      if (!athlete || athlete.includes("/") || athlete.includes("..") || athlete.length > 60) return reply("not found", 404);
      if (request.method === "GET") return viewOk ? json(await listComments(env.VIDEOS, athlete)) : reply("見る用の合言葉が違います", 401);
      if (request.method !== "POST") return reply("method not allowed", 405);
      if (!uploadOk) return reply("合言葉が違います", 401);
      const saved = await postComment(env.VIDEOS, athlete, await request.json().catch(() => null));
      return saved ? json(saved) : reply("コメントが空です", 400);
    }

    const key = objectKey(url.pathname);
    if (!key) return reply("not found", 404);

    if (request.method === "PUT") {
      if (!uploadOk) return reply("保存用の合言葉が違います", 401);
      const size = Number(request.headers.get("Content-Length") || 0);
      if (size > MAX_BYTES) return reply("ファイルが大きすぎます", 413);
      await env.VIDEOS.put(key, request.body, { httpMetadata: { contentType: request.headers.get("Content-Type") || "application/octet-stream" } });
      return json({ key });
    }
    if (request.method === "GET") {
      if (!viewOk) return reply("見る用の合言葉が違います", 401);
      const object = await env.VIDEOS.get(key);
      if (!object) return reply("not found", 404);
      const type = object.httpMetadata?.contentType || "application/octet-stream";
      // 解析結果（JSON）は上書きされるので毎回読み直す。動画は変わらないので1時間ためる
      return reply(object.body, 200, { "Content-Type": type, "Cache-Control": type.includes("json") ? "no-store" : "public, max-age=3600" });
    }
    return reply("method not allowed", 405);
  },
};
