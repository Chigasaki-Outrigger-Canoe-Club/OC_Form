import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionPath, videoPath, listSavedSessions, rawUrl, loadSettings, DEFAULT_SETTINGS } from "../js/github.js";

const session = { id: "s1", athleteName: "Manato", date: "2026-10-20", memo: "40spm", views: {} };

test("保存先のパス（解析結果・動画）", () => {
  assert.equal(sessionPath(session), "data/Manato/2026-10-20_s1.json");
  assert.equal(sessionPath({ ...session, athleteName: "a/b c" }), "data/a_b_c/2026-10-20_s1.json");
  assert.equal(videoPath({ athleteName: "Manato", date: "2026-10-24", id: "s1" }, "front"), "data/Manato/2026-10-24_s1_front.mp4");
});

test("設定：保存がなければ既定、Worker の URL が空なら既定の Worker", () => {
  const storage = (v) => ({ getItem: () => (v == null ? null : JSON.stringify(v)) });
  assert.equal(loadSettings(storage(null)).r2Url, DEFAULT_SETTINGS.r2Url);
  assert.equal(loadSettings(storage({ r2Url: "", r2Upload: "k" })).r2Url, DEFAULT_SETTINGS.r2Url);
  assert.equal(loadSettings(storage({ r2Upload: "k" })).r2Upload, "k");
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


test("選手のデータかどうかはフォルダ名（選手名）で判断する", async () => {
  const { sameAthlete } = await import("../js/github.js");
  assert.ok(sameAthlete("Manato", "Manato"));
  assert.ok(sameAthlete("GAI", "Gai"));            // 大文字・小文字は区別しない
  assert.ok(sameAthlete("a_b", "a b"));            // 保存のときと同じく空白は _ に
  assert.ok(!sameAthlete("Reo", "Reona"));
});
