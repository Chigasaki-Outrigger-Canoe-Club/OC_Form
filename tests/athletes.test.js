import { test } from "node:test";
import assert from "node:assert/strict";
import * as A from "../js/athletes.js";

// localStorage の代わり
function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => (data[k] = String(v)), data };
}

const values = { height: "166", weight: "70", paddle: "49", bladeLength: "", bladeWidth: "" };

test("保存がなければ空", () => {
  assert.deepEqual(A.loadStore(memoryStorage()), { current: null, list: [] });
});

test("以前の1人分の保存は「選手1」として引き継ぐ", () => {
  const store = A.loadStore(memoryStorage({ "oc-form-athlete": JSON.stringify(values) }));
  assert.equal(store.list.length, 1);
  assert.equal(store.list[0].name, "選手1");
  assert.deepEqual(store.list[0].values, values);
  assert.equal(store.current, store.list[0].id);
});

test("追加・選択・保存・読み込み", () => {
  const storage = memoryStorage();
  let store = A.addAthlete(A.loadStore(storage), " Manato ", values);
  assert.equal(A.currentAthlete(store).name, "Manato");
  store = A.addAthlete(store, "Taro", {});
  assert.equal(A.currentAthlete(store).name, "Taro");
  A.saveStore(storage, store);
  const loaded = A.loadStore(storage);
  assert.equal(loaded.list.length, 2);
  assert.deepEqual(loaded.list[0].values, values);
});

test("同じ名前は追加せずその選手を選ぶ、空の名前は無視", () => {
  let store = A.addAthlete({ current: null, list: [] }, "Manato", values);
  store = A.addAthlete(store, "Taro", {});
  store = A.addAthlete(store, "Manato", {});
  assert.equal(store.list.length, 2);
  assert.equal(A.currentAthlete(store).name, "Manato");
  assert.equal(A.addAthlete(store, "  ", {}), store);
});

test("値の更新は選択中の選手だけ", () => {
  let store = A.addAthlete({ current: null, list: [] }, "Manato", values);
  store = A.addAthlete(store, "Taro", {});
  store = A.updateValues(store, { height: "180" });
  assert.equal(store.list[1].values.height, "180");
  assert.equal(store.list[0].values.height, "166");
});

test("名前変更と削除", () => {
  let store = A.addAthlete({ current: null, list: [] }, "選手1", values);
  store = A.renameAthlete(store, store.current, "Manato");
  assert.equal(A.currentAthlete(store).name, "Manato");
  store = A.removeAthlete(store, store.current);
  assert.deepEqual(store, { current: null, list: [] });
});

test("バックアップの書き出しと読み込み", () => {
  const store = A.addAthlete({ current: null, list: [] }, "Manato", values);
  const restored = A.parseBackup(JSON.stringify(A.buildBackup(store)));
  assert.deepEqual(restored, store);
  assert.throws(() => A.parseBackup('{"format":"other"}'));
});

test("保存できない環境では false", () => {
  const broken = { getItem: () => null, setItem: () => { throw new Error("full"); } };
  assert.equal(A.saveStore(broken, { current: null, list: [] }), false);
});
