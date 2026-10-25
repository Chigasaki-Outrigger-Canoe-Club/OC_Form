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
//   PUT /github/<保存先>  ヘッダー X-Upload-Key ＝ UPLOAD_KEY  → 解析結果を GitHub の data ブランチに保存（data/ の下だけ）
//   GET /check            ヘッダー X-Upload-Key（任意）        → 合言葉が合っているかの確認
// GitHub への保存には Secret の GITHUB_TOKEN（OC_Form の Contents を読み書きできるトークン）を使う。
//   トークンを Worker に置くので、サイトや各端末にトークンを入れなくてよい

const MAX_BYTES = 90 * 1024 * 1024;
const GITHUB_REPO = "chigasaki-outrigger-canoe-club/OC_Form";
const GITHUB_BRANCH = "data"; // 1本の上限（Workers の無料プランは 100MB まで受け取れる）

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Upload-Key, X-View-Key, X-Message",
};
const reply = (body, status = 200, headers = {}) => new Response(body, { status, headers: { ...cors, ...headers } });

// 保存先の名前：/videos/ のあと。「..」や先頭の / は認めない（ほかの場所を指さないように）
function objectKey(pathname, prefix = "/videos/") {
  if (!pathname.startsWith(prefix)) return null;
  const key = decodeURIComponent(pathname.slice(prefix.length));
  if (!key || key.startsWith("/") || key.split("/").includes("..") || key.length > 300) return null;
  return key;
}

// バイト列 → Base64（大きくても止まらないよう分けて変換）
function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// GitHub の data ブランチにファイルを保存（同じファイルがあれば上書き）。戻り値：GitHub 上の URL
async function putGitHub(env, path, bytes, message, fetchFn = fetch) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "oc-form-video" };
  const existing = await fetchFn(`${url}?ref=${GITHUB_BRANCH}`, { headers });
  const sha = existing.ok ? (await existing.json()).sha : undefined;
  const res = await fetchFn(url, { method: "PUT", headers, body: JSON.stringify({ message, content: toBase64(bytes), branch: GITHUB_BRANCH, sha }) });
  if (!res.ok) throw new Error(`GitHub ${res.status}：${(await res.json().catch(() => ({}))).message ?? ""}`);
  return (await res.json()).content.html_url;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return reply(null, 204);
    const url = new URL(request.url);
    const uploadOk = Boolean(env.UPLOAD_KEY) && request.headers.get("X-Upload-Key") === env.UPLOAD_KEY;
    const viewOk = !env.VIEW_KEY || request.headers.get("X-View-Key") === env.VIEW_KEY || uploadOk;

    if (url.pathname === "/check") return reply(JSON.stringify({ upload: uploadOk, view: viewOk, github: Boolean(env.GITHUB_TOKEN) }), 200, { "Content-Type": "application/json" });

    // 解析結果・選手データを GitHub へ
    const ghPath = objectKey(url.pathname, "/github/");
    if (ghPath && request.method === "PUT") {
      if (!uploadOk) return reply("保存用の合言葉が違います", 401);
      if (!ghPath.startsWith("data/")) return reply("data/ の下だけ保存できます", 403);
      if (!env.GITHUB_TOKEN) return reply("Worker に GITHUB_TOKEN が入っていません", 500);
      try {
        const message = decodeURIComponent(request.headers.get("X-Message") || "解析結果を保存");
        const html = await putGitHub(env, ghPath, new Uint8Array(await request.arrayBuffer()), message, env.fetch ?? fetch); // env.fetch はテスト用の差し替え（本番では通常の fetch）
        return reply(JSON.stringify({ url: html }), 200, { "Content-Type": "application/json" });
      } catch (err) {
        return reply(err.message, 502);
      }
    }

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
