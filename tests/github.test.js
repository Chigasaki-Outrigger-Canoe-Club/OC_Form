import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionPath, toBase64, testConnection, uploadSession, listSavedSessions, rawUrl, DEFAULT_SETTINGS } from "../js/github.js";

const settings = { ...DEFAULT_SETTINGS, token: "t" };
const session = { id: "s1", athleteName: "Manato", date: "2026-10-20", memo: "40spm", views: {} };

// GitHub API の代わり：routes[「メソッド パス」] が返す値。呼ばれた内容を calls に記録
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, options) => {
    const method = options.method ?? "GET";
    const path = url.replace("https://api.github.com/repos/chigasaki-outrigger-canoe-club/OC_Form", "");
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : null, auth: options.headers.Authorization });
    const value = routes[`${method} ${path}`];
    if (value === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (value instanceof Error) return { ok: false, status: 403, json: async () => ({ message: value.message }) };
    return { ok: true, status: 200, json: async () => value };
  };
  return { fn, calls };
}

test("保存先のパスと中身", () => {
  assert.equal(sessionPath(session), "data/Manato/2026-10-20_s1.json");
  assert.equal(sessionPath({ ...session, athleteName: "a/b c" }), "data/a_b_c/2026-10-20_s1.json");
});

test("Base64：日本語を含む文字列を元に戻せる", () => {
  const text = "体幹の前傾 ✓ " + "x".repeat(100000);
  assert.equal(Buffer.from(toBase64(text), "base64").toString("utf8"), text);
});

test("接続テスト：書き込み権限がないとエラー", async () => {
  const ok = mockFetch({ "GET ": { private: false, default_branch: "main", permissions: { push: true } } });
  assert.deepEqual(await testConnection(settings, ok.fn), { private: false, defaultBranch: "main" });
  assert.equal(ok.calls[0].auth, "Bearer t");
  const readOnly = mockFetch({ "GET ": { permissions: { push: false } } });
  await assert.rejects(testConnection(settings, readOnly.fn), /書き込み権限/);
  await assert.rejects(testConnection(settings, mockFetch({}).fn), /見つかりません/);
});

test("保存：dataブランチがなければ作り、新しいファイルを作る", async () => {
  const m = mockFetch({
    "GET ": { default_branch: "main" },
    "GET /git/ref/heads/main": { object: { sha: "abc" } },
    "POST /git/refs": {},
    "PUT /contents/data/Manato/2026-10-20_s1.json": { content: { html_url: "https://github.com/x" } },
  });
  const url = await uploadSession(settings, session, m.fn);
  assert.equal(url, "https://github.com/x");
  const create = m.calls.find((c) => c.method === "POST");
  assert.deepEqual(create.body, { ref: "refs/heads/data", sha: "abc" });
  const put = m.calls.find((c) => c.method === "PUT");
  assert.equal(put.body.branch, "data");
  assert.equal(put.body.sha, undefined);
  assert.equal(JSON.parse(Buffer.from(put.body.content, "base64").toString("utf8")).id, "s1");
});

test("保存：同じファイルがあれば sha を付けて上書き", async () => {
  const m = mockFetch({
    "GET /branches/data": {},
    "GET /contents/data/Manato/2026-10-20_s1.json?ref=data": { sha: "old" },
    "PUT /contents/data/Manato/2026-10-20_s1.json": { content: { html_url: "u" } },
  });
  await uploadSession(settings, session, m.fn);
  assert.equal(m.calls.find((c) => c.method === "PUT").body.sha, "old");
  assert.equal(m.calls.some((c) => c.method === "POST"), false);
});

test("保存：GitHubのエラーはメッセージ付きで伝える", async () => {
  const m = mockFetch({ "GET /branches/data": new Error("Bad credentials") });
  await assert.rejects(uploadSession(settings, session, m.fn), /403：Bad credentials/);
});

test("一覧：data/選手名/ファイル.json だけを新しい順に（トークン不要）", async () => {
  const tree = [
    { type: "blob", path: "index.html" },
    { type: "tree", path: "data/Manato" },
    { type: "blob", path: "data/Manato/2026-10-01_a.json" },
    { type: "blob", path: "data/Manato/2026-10-20_b.json" },
    { type: "blob", path: "data/x/y/z.json" },
  ];
  const fn = async (url) => {
    assert.match(url, /\/git\/trees\/data\?recursive=1$/);
    return { ok: true, status: 200, json: async () => ({ tree }) };
  };
  const list = await listSavedSessions(DEFAULT_SETTINGS, fn);
  assert.deepEqual(list.map((x) => x.name), ["2026-10-20_b", "2026-10-01_a"]);
  assert.equal(list[0].athlete, "Manato");
  assert.deepEqual(await listSavedSessions(DEFAULT_SETTINGS, async () => ({ ok: false, status: 404 })), []);
  assert.equal(rawUrl(DEFAULT_SETTINGS, "data/まなと/a.json"),
    "https://raw.githubusercontent.com/chigasaki-outrigger-canoe-club/OC_Form/data/data/%E3%81%BE%E3%81%AA%E3%81%A8/a.json");
});
