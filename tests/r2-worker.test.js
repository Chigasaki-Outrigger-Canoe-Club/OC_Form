import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../tools/r2-worker/worker.js";

// R2 の代わり（メモリ）
function fakeEnv(viewKey = "") {
  const store = new Map();
  return {
    UPLOAD_KEY: "up", VIEW_KEY: viewKey,
    VIDEOS: {
      put: async (k, body, opts) => store.set(k, { bytes: await new Response(body).arrayBuffer(), type: opts.httpMetadata.contentType }),
      get: async (k) => (store.has(k) ? { body: store.get(k).bytes, httpMetadata: { contentType: store.get(k).type } } : null),
    },
  };
}
const req = (method, path, headers = {}, body) => new Request(`https://w.example${path}`, { method, headers, body });

test("保存先の名前：/videos/ のあとだけ。「..」やほかの場所は 404", async () => {
  const env = fakeEnv();
  const put = (path) => worker.fetch(req("PUT", path, { "X-Upload-Key": "up" }, "x"), env);
  assert.equal((await put("/videos/data/%E9%81%B8%E6%89%8B/a.mp4")).status, 200);
  assert.equal((await worker.fetch(req("GET", "/videos/data/%E9%81%B8%E6%89%8B/a.mp4"), env)).status, 200);
  assert.equal((await put("/videos/..%2Fx")).status, 404);
  assert.equal((await put("/other/x")).status, 404);
});

test("保存は保存用の合言葉が必要、再生は再生用の合言葉が必要", async () => {
  const env = fakeEnv("view");
  assert.equal((await worker.fetch(req("PUT", "/videos/a.mp4", {}, "x"), env)).status, 401);
  assert.equal((await worker.fetch(req("PUT", "/videos/a.mp4", { "X-Upload-Key": "up", "Content-Type": "video/mp4" }, "abc"), env)).status, 200);
  assert.equal((await worker.fetch(req("GET", "/videos/a.mp4"), env)).status, 401);
  const ok = await worker.fetch(req("GET", "/videos/a.mp4", { "X-View-Key": "view" }), env);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "abc");
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), "*");
  // 再生用の合言葉を空にすると誰でも再生できる
  const open = fakeEnv("");
  await worker.fetch(req("PUT", "/videos/b.mp4", { "X-Upload-Key": "up" }, "b"), open);
  assert.equal((await worker.fetch(req("GET", "/videos/b.mp4"), open)).status, 200);
});

test("コメント：合言葉があれば書き込め、誰でも古い順に読める。日時は Worker が付け、空のコメントは受け付けない", async () => {
  const store = new Map();
  const env = { UPLOAD_KEY: "up", VIDEOS: {
    put: async (k, body) => store.set(k, typeof body === "string" ? body : await new Response(body).text()),
    get: async (k) => (store.has(k) ? { json: async () => JSON.parse(store.get(k)) } : null),
    list: async ({ prefix }) => ({ objects: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false }) } };
  const post = (body, key = "up") => worker.fetch(new Request("https://w.example/comments/%E3%82%8C%E3%81%8A", {
    method: "POST", headers: { "X-Upload-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
  assert.equal((await post({ name: "コーチ", text: "キャッチで前傾を深く" })).status, 200);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await post({ name: "", text: "肘が伸びてきた" })).status, 200);
  assert.equal((await post({ name: "x", text: "  " })).status, 400);
  assert.equal((await post({ name: "x", text: "y" }, "bad")).status, 401);
  const list = await (await worker.fetch(new Request("https://w.example/comments/%E3%82%8C%E3%81%8A"), env)).json();
  assert.deepEqual(list.map((c) => [c.name, c.text]), [["コーチ", "キャッチで前傾を深く"], ["名無し", "肘が伸びてきた"]]);
  assert.ok(list[0].at < list[1].at);
  assert.equal((await worker.fetch(new Request("https://w.example/comments/a%2F..%2Fb"), env)).status, 404);
});
