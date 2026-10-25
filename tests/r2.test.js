import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../tools/r2-worker/worker.js";
import { checkR2, uploadVideoR2, fetchVideo, useR2 } from "../js/r2.js";

// サイト（r2.js）→ Worker（worker.js）→ R2（メモリ）を、通信なしでつなぐ
function setup() {
  const store = new Map();
  const env = {
    UPLOAD_KEY: "up", VIEW_KEY: "view",
    VIDEOS: {
      put: async (k, body) => store.set(k, await new Response(body).arrayBuffer()),
      get: async (k) => (store.has(k) ? { body: store.get(k), httpMetadata: { contentType: "video/mp4" } } : null),
    },
  };
  const fetchFn = (url, init) => worker.fetch(new Request(url, init), env);
  return { store, fetchFn };
}

test("R2：合言葉の確認・保存・読み込み（日本語の選手名も）", async () => {
  const { store, fetchFn } = setup();
  const settings = { r2Url: "https://w.example/", r2Upload: "up", r2View: "view" };
  assert.ok(useR2(settings) && !useR2({ r2Url: "" }));
  assert.deepEqual(await checkR2(settings, fetchFn), { upload: true, view: true });
  const session = { id: "abc", athleteName: "れお", date: "2026-10-25" };
  const path = await uploadVideoR2(settings, session, "right", new Blob(["movie"]), fetchFn);
  assert.equal(path, "data/れお/2026-10-25_abc_right.mp4");
  assert.ok(store.has(path));
  const file = await fetchVideo(settings, { r2: path }, fetchFn);
  assert.equal(await file.text(), "movie");
  // 再生用の合言葉が違うと読めない（GitHub の動画もなければ null）
  assert.equal(await fetchVideo({ ...settings, r2View: "x" }, { r2: path }, fetchFn), null);
  await assert.rejects(uploadVideoR2({ ...settings, r2Upload: "x" }, session, "left", new Blob(["m"]), fetchFn), /401/);
});
