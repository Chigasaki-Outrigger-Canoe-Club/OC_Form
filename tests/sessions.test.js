import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSession, sortSessions, viewToRecord, buildSessionFile, parseSessionFile } from "../js/sessions.js";

const athlete = { id: "a1", name: "Manato", values: { height: "166" } };

const view = (pose) => ({
  file: { size: 1000 }, url: "blob:x", name: "VID.mp4", fps: 30, fpsSource: "（動画から取得）", codec: "hvc1",
  pose, world: pose, body: "表示用", strokes: [{ frame: 0, side: "right", src: "auto" }],
});

test("保存する形：動画本体・表示用の値は含めない", () => {
  const r = viewToRecord(view([[1]]));
  assert.deepEqual(Object.keys(r).sort(), ["pose", "spine", "strokes", "video", "world"]);
  assert.equal(r.video.size, 1000);
  assert.equal(r.video.codec, "hvc1");
  assert.equal(JSON.stringify(r).includes("blob:"), false);
});

test("セッション：選手・日付・メモ・方向ごとのデータ", () => {
  const now = new Date("2026-10-20T09:00:00Z");
  const s = buildSession({ athlete, date: "2026-10-20", memo: "40spm", views: { left: view([[1]]), back: view(null) }, now });
  assert.equal(s.athleteId, "a1");
  assert.equal(s.athleteName, "Manato");
  assert.deepEqual(Object.keys(s.views), ["left", "back"]);
  assert.equal(s.savedAt, "2026-10-20T09:00:00.000Z");
  assert.ok(s.id);
  // 上書き保存では同じIDを使う
  assert.equal(buildSession({ id: "s1", athlete, date: "", memo: "", views: {} }).id, "s1");
});

test("一覧の並び順（新しい練習日が先）", () => {
  const list = sortSessions([
    { date: "2026-10-01", savedAt: "2026-10-01T00:00:00Z" },
    { date: "2026-10-20", savedAt: "2026-10-20T01:00:00Z" },
    { date: "2026-10-20", savedAt: "2026-10-20T05:00:00Z" },
  ]);
  assert.deepEqual(list.map((x) => x.savedAt), ["2026-10-20T05:00:00Z", "2026-10-20T01:00:00Z", "2026-10-01T00:00:00Z"]);
});

test("ファイル：書き出し→読み込みで元に戻る、形式が違えばエラー", () => {
  const s = buildSession({ athlete, date: "2026-10-20", memo: "m", views: { left: view([[1]]) } });
  const file = buildSessionFile(s);
  assert.equal(file.format, "oc-form-session");
  assert.deepEqual(parseSessionFile(JSON.stringify(file)), JSON.parse(JSON.stringify(s)));
  assert.throws(() => parseSessionFile('{"format":"oc-form-analysis"}'), /このシステム/);
  assert.throws(() => parseSessionFile("not json"));
});
