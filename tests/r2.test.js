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
  assert.deepEqual(await checkR2(settings, fetchFn), { upload: true, view: true, github: false });
  const session = { id: "abc", athleteName: "れお", date: "2026-10-25" };
  const path = await uploadVideoR2(settings, session, "right", new Blob(["movie"]), fetchFn);
  assert.equal(path, "data/れお/2026-10-25_abc_right.mp4");
  assert.ok(store.has(path));
  const file = await fetchVideo(settings, { r2: path }, fetchFn);
  assert.equal(await file.text(), "movie");
  // 再生用の合言葉が違うと読めない（GitHub の動画もなければ null）
  assert.equal(await fetchVideo({ ...settings, r2Upload: "", r2View: "x" }, { r2: path }, fetchFn), null);
  await assert.rejects(uploadVideoR2({ ...settings, r2Upload: "x" }, session, "left", new Blob(["m"]), fetchFn), /401/);
});

test("GitHub への保存は Worker 経由（トークンは Worker、サイトは保存用の合言葉だけ）", async () => {
  const calls = [];
  // GitHub API の代わり：既存ファイルなし → PUT を受けて URL を返す
  const githubFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", auth: init.headers?.Authorization, body: init.body && JSON.parse(init.body) });
    if (!init.method) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ content: { html_url: "https://github.com/x" } }));
  };
  const env = { UPLOAD_KEY: "up", GITHUB_TOKEN: "secret", fetch: githubFetch, VIDEOS: {} };
  const fetchFn = (url, init) => worker.fetch(new Request(url, init), env);
  const { uploadAthletes, canSave } = await import("../js/github.js");
  const settings = { token: "", r2Url: "https://w.example", r2Upload: "up" };
  assert.ok(canSave(settings) && !canSave({ ...settings, r2Upload: "" }));
  assert.equal(await uploadAthletes(settings, { list: [] }, fetchFn), "https://github.com/x");
  const put = calls.find((c) => c.method === "PUT");
  assert.equal(put.auth, "Bearer secret");
  assert.equal(put.body.branch, "data");
  assert.equal(Buffer.from(put.body.content, "base64").toString(), JSON.stringify({ list: [] }, null, 1));
  // data/ の外・合言葉違いは保存しない
  assert.equal((await fetchFn("https://w.example/github/README.md", { method: "PUT", headers: { "X-Upload-Key": "up" }, body: "x" })).status, 403);
  await assert.rejects(uploadAthletes({ ...settings, r2Upload: "x" }, { list: [] }, fetchFn), /401/);
});

test("保存用の合言葉だけで動画も再生できる（合言葉は1つでよい）", async () => {
  const store = new Map();
  const env = { UPLOAD_KEY: "up", VIEW_KEY: "view", VIDEOS: {
    put: async (k, body) => store.set(k, await new Response(body).arrayBuffer()),
    get: async (k) => (store.has(k) ? { body: store.get(k), httpMetadata: {} } : null) } };
  const fetchFn = (url, init) => worker.fetch(new Request(url, init), env);
  const settings = { r2Url: "https://w.example", r2Upload: "up" };
  const path = await uploadVideoR2(settings, { id: "a", athleteName: "x", date: "d" }, "left", new Blob(["v"]), fetchFn);
  assert.equal(await (await fetchVideo(settings, { r2: path }, fetchFn)).text(), "v");
});
