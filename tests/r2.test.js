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
  assert.equal(await fetchVideo({ ...settings, r2Upload: "", r2View: "x" }, { r2: path }, fetchFn), null);
  await assert.rejects(uploadVideoR2({ ...settings, r2Upload: "x" }, session, "left", new Blob(["m"]), fetchFn), /401/);
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

test("解析結果・選手データも Cloudflare に保存し、一覧と読み込みは Cloudflare → GitHub の順", async () => {
  const store = new Map();
  const env = { UPLOAD_KEY: "up", VIDEOS: {
    put: async (k, body) => store.set(k, await new Response(body).arrayBuffer()),
    get: async (k) => (store.has(k) ? { body: store.get(k), httpMetadata: { contentType: "application/json" } } : null),
    list: async ({ prefix }) => ({ objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1 })), truncated: false }) } };
  // GitHub（古いデータ）の代わり：一覧に1件、中身も返す
  const old = { id: "o", athleteName: "Gai", date: "2026-10-21", views: { left: { video: { github: "data/Gai/2026-10-21_o_left.mp4" } } } };
  const fetchFn = async (url, init) => {
    if (url.includes("api.github.com")) return new Response(JSON.stringify({ tree: [
      { type: "blob", path: "data/Gai/2026-10-21_o.json" }, { type: "blob", path: "data/Gai/2026-10-21_o_left.mp4" }] }));
    if (url.includes("raw.githubusercontent.com")) return new Response(url.endsWith(".json") ? JSON.stringify(old) : "video");
    return worker.fetch(new Request(url, init), env);
  };
  const { uploadSession, uploadAthletes, listSessions, readText, migrateFromGitHub, ATHLETES_PATH } = await import("../js/r2.js");
  const settings = { owner: "o", repo: "r", branch: "data", r2Url: "https://w.example", r2Upload: "up" };
  const session = { id: "n", athleteName: "Reo", athleteId: "a1", date: "2026-10-24", memo: "", views: {} };
  await uploadSession(settings, session, fetchFn);
  await uploadAthletes(settings, { list: [] }, fetchFn);
  assert.ok(store.has("data/Reo/2026-10-24_n.json") && store.has(ATHLETES_PATH));
  const list = await listSessions(settings, fetchFn);
  assert.deepEqual(list.map((x) => [x.athlete, x.source]), [["Reo", "r2"], ["Gai", "github"]]); // 選手データ（athletes.json）は一覧に出さない
  assert.equal(JSON.parse(await readText(settings, "data/Reo/2026-10-24_n.json", fetchFn)).athleteName, "Reo");
  // GitHub の古いデータを移す：JSON には動画の場所（r2）を書き足す。2回目は移すものがない
  assert.equal(await migrateFromGitHub(settings, () => {}, fetchFn), 2);
  assert.equal(JSON.parse(new TextDecoder().decode(store.get("data/Gai/2026-10-21_o.json"))).views.left.video.r2, "data/Gai/2026-10-21_o_left.mp4");
  assert.equal(await migrateFromGitHub(settings, () => {}, fetchFn), 0);
});

test("Cloudflare に届かなくても、GitHub の古いデータの一覧は出す", async () => {
  const { listSessions } = await import("../js/r2.js");
  const fetchFn = async (url) => {
    if (url.includes("api.github.com")) return new Response(JSON.stringify({ tree: [{ type: "blob", path: "data/GAI/2026-10-24_a.json" }] }));
    throw new TypeError("Failed to fetch");
  };
  const list = await listSessions({ owner: "o", repo: "r", branch: "data", r2Url: "https://w.example" }, fetchFn);
  assert.deepEqual(list.map((x) => x.athlete), ["GAI"]);
});
