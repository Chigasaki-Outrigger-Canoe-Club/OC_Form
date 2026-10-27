import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../tools/r2-worker/worker.js";
import { fetchComments, postComment, changeComment, formatAt } from "../js/comments.js";

test("コメント：サイト → Worker で書き込み、古い順に読める", async () => {
  const store = new Map();
  const env = { UPLOAD_KEY: "up", VIDEOS: {
    put: async (k, body) => store.set(k, body),
    get: async (k) => (store.has(k) ? { json: async () => JSON.parse(store.get(k)) } : null),
    list: async ({ prefix }) => ({ objects: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false }) } };
  const fetchFn = (url, init) => worker.fetch(new Request(url, init), env);
  const settings = { r2Url: "https://w.example/", r2Upload: "up" };
  await postComment(settings, "Reo", "Manato", "リーチが伸びた\n次は肘", fetchFn);
  const list = await fetchComments(settings, "Reo", fetchFn);
  assert.equal(list.length, 1);
  assert.equal(list[0].text, "リーチが伸びた\n次は肘");
  assert.deepEqual(await fetchComments(settings, "GAI", fetchFn), []); // 選手ごとに分かれる
  await assert.rejects(postComment({ ...settings, r2Upload: "x" }, "Reo", "a", "b", fetchFn), /401/);
  // 名前変更・編集・削除
  env.VIDEOS.delete = async (k) => store.delete(k);
  const id = list[0].id;
  await changeComment(settings, "Reo", id, { name: "コーチ" }, fetchFn);
  await changeComment(settings, "Reo", id, { text: "リーチが伸びた" }, fetchFn);
  const [c] = await fetchComments(settings, "Reo", fetchFn);
  assert.deepEqual([c.name, c.text], ["コーチ", "リーチが伸びた"]);
  await changeComment(settings, "Reo", id, null, fetchFn);
  assert.deepEqual(await fetchComments(settings, "Reo", fetchFn), []);
});

test("日時の表示：2026/10/27(火) 11:12", () => {
  assert.equal(formatAt(new Date(2026, 9, 27, 11, 12).toISOString()), "2026/10/27(火) 11:12");
});
