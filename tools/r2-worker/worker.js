// 動画の保存場所（Cloudflare R2）とサイトの間に立つ小さなプログラム（Cloudflare Worker）
//
// 何のため：R2 の鍵をサイトに置かずに、合言葉を知っている人だけが動画を保存・再生できるようにする
// 使い方（Cloudflare の画面で設定）：
//   - R2 バケットを「VIDEOS」という名前で結び付ける（Bindings → R2 bucket）
//   - 合言葉を2つ入れる（Variables and Secrets → Secret）
//       UPLOAD_KEY：保存用（保存するPCだけが知る）
//       VIEW_KEY  ：再生用（クラブのメンバーに伝える。空にすると誰でも再生できる）
// 受け付けるもの：
//   PUT /videos/<保存先>  ヘッダー X-Upload-Key ＝ UPLOAD_KEY  → 動画を保存
//   GET /videos/<保存先>  ヘッダー X-View-Key  ＝ VIEW_KEY    → 動画を返す
//   GET /check            ヘッダー X-Upload-Key（任意）        → 合言葉が合っているかの確認

const MAX_BYTES = 90 * 1024 * 1024; // 1本の上限（Workers の無料プランは 100MB まで受け取れる）

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Upload-Key, X-View-Key",
};
const reply = (body, status = 200, headers = {}) => new Response(body, { status, headers: { ...cors, ...headers } });

// 保存先の名前：/videos/ のあと。「..」や先頭の / は認めない（ほかの場所を指さないように）
function objectKey(pathname) {
  if (!pathname.startsWith("/videos/")) return null;
  const key = decodeURIComponent(pathname.slice("/videos/".length));
  if (!key || key.startsWith("/") || key.split("/").includes("..") || key.length > 300) return null;
  return key;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return reply(null, 204);
    const url = new URL(request.url);
    const uploadOk = Boolean(env.UPLOAD_KEY) && request.headers.get("X-Upload-Key") === env.UPLOAD_KEY;
    const viewOk = !env.VIEW_KEY || request.headers.get("X-View-Key") === env.VIEW_KEY || uploadOk;

    if (url.pathname === "/check") return reply(JSON.stringify({ upload: uploadOk, view: viewOk }), 200, { "Content-Type": "application/json" });

    const key = objectKey(url.pathname);
    if (!key) return reply("not found", 404);

    if (request.method === "PUT") {
      if (!uploadOk) return reply("保存用の合言葉が違います", 401);
      const size = Number(request.headers.get("Content-Length") || 0);
      if (size > MAX_BYTES) return reply("動画が大きすぎます", 413);
      await env.VIDEOS.put(key, request.body, { httpMetadata: { contentType: request.headers.get("Content-Type") || "video/mp4" } });
      return reply(JSON.stringify({ key }), 200, { "Content-Type": "application/json" });
    }
    if (request.method === "GET") {
      if (!viewOk) return reply("再生用の合言葉が違います", 401);
      const object = await env.VIDEOS.get(key);
      if (!object) return reply("not found", 404);
      return reply(object.body, 200, { "Content-Type": object.httpMetadata?.contentType || "video/mp4", "Cache-Control": "private, max-age=3600" });
    }
    return reply("method not allowed", 405);
  },
};
