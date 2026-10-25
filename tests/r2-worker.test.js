import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { objectKey } from "../tools/r2-worker/worker.js";

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

test("保存先の名前：/videos/ のあとだけ。「..」は認めない", () => {
  assert.equal(objectKey("/videos/data/%E9%81%B8%E6%89%8B/a.mp4"), "data/選手/a.mp4");
  assert.equal(objectKey("/videos/../x"), null);
  assert.equal(objectKey("/other/x"), null);
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
