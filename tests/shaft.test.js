import { test } from "node:test";
import assert from "node:assert/strict";
import { detectShaft, rgbToHsv, learnWood, isWood, WOOD } from "../js/shaft.js";
import { P } from "../js/angles.js";

// 200×200 の画像：灰色の背景に、木の色の斜めの棒（太さ3px）と、木の色の床（下の広い面）
function image(withFloor) {
  const w = 200, h = 200;
  const data = new Uint8ClampedArray(w * h * 4).fill(120);
  const paint = (x, y, [r, g, b]) => { const i = (y * w + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; };
  for (let k = -60; k <= 60; k++) for (let d = -1; d <= 1; d++) paint(100 + Math.round(k * 0.5) + d, 100 + k, [210, 160, 80]); // 縦から約27°
  if (withFloor) for (let y = 170; y < 200; y++) for (let x = 0; x < w; x++) paint(x, y, [200, 150, 75]);
  return { data, width: w, height: h };
}
function pose() {
  const p = Array.from({ length: 33 }, () => ({ x: 100, y: 100, v: 0.9 }));
  p[P.lShoulder] = { x: 140, y: 40, v: 0.9 };
  p[P.rShoulder] = { x: 60, y: 40, v: 0.9 };
  p[P.lWrist] = { x: 85, y: 70, v: 0.9 };  // 上の手（棒の上の方）
  p[P.rWrist] = { x: 110, y: 120, v: 0.9 }; // 下の手
  return p;
}

test("木の色の判定：木と肌を分ける", () => {
  assert.equal(isWood(rgbToHsv(210, 160, 80), WOOD), true);   // 木
  assert.equal(isWood(rgbToHsv(220, 170, 140), WOOD), false);  // 明るい肌
  assert.equal(isWood(rgbToHsv(170, 110, 80), WOOD), false);   // 日焼けした肌
});

test("シャフトの向きを見つける（床があっても）", () => {
  for (const floor of [false, true]) {
    const s = detectShaft(image(floor), 1, pose());
    assert.ok(s, `floor=${floor}`);
    const deg = (Math.atan2(s.dir[0], s.dir[1]) * 180) / Math.PI; // 縦からの傾き
    assert.ok(Math.abs(deg - 26.6) < 4, `floor=${floor} deg=${deg}`);
  }
});

test("木の色がなければ見つからない", () => {
  const img = { data: new Uint8ClampedArray(200 * 200 * 4).fill(120), width: 200, height: 200 };
  assert.equal(detectShaft(img, 1, pose()), null);
});

test("見つけたシャフトの色から、木の色を覚え直す", () => {
  const img = image(false);
  const s = detectShaft(img, 1, pose());
  const learned = learnWood(img, s, 1);
  assert.ok(Math.abs(learned.hue - rgbToHsv(210, 160, 80).h) < 2);
});

test("パドルの向き：左右・上下はシャフトに合わせ、前後は両手から", async () => {
  const { alignToShaft } = await import("../js/body3d.js");
  const d = { x: 0.6, y: -0.6, z: 0.53 };             // 両手から決めた向き（斜め）
  const out = alignToShaft(d, { x: 0, y: -1, z: 0 }); // 前から見てシャフトは真っすぐ下
  assert.ok(Math.abs(out.x) < 1e-9);
  assert.ok(out.y < 0);
  assert.ok(Math.abs(out.z / Math.hypot(out.y, out.z) - 0.53 / Math.hypot(0.85, 0.53)) < 0.01); // 前後の割合は保つ
  assert.deepEqual(alignToShaft(d, null), d);
});

test("シャフトの向きを位相ごとに平均（見つからない位相は補間）", async () => {
  const { averageShaft, PHASES } = await import("../js/fusion.js");
  const a = Array.from({ length: PHASES }, (_, i) => (i % 10 === 0 ? null : { x: 0, y: -1, z: 0, s: 1 }));
  const b = Array.from({ length: PHASES }, () => ({ x: 0.2, y: -0.98, z: 0, s: 0.5 }));
  const avg = averageShaft([a, b]);
  assert.equal(avg.length, PHASES);
  assert.ok(avg[5].x > 0 && avg[5].x < 0.1); // 確かさで重み付け（a が重い）
  assert.ok(avg[10]);                       // a が見つからなくても b がある
});

test("急に向きが変わった見つけ違いを外す", async () => {
  const { cleanShafts } = await import("../js/shaft.js");
  const sh = (dx) => ({ dir: [dx, Math.sqrt(1 - dx * dx)], point: [0, 0], s: 1 });
  const list = [sh(0.17), sh(0.2), sh(0.17), sh(-0.17), sh(0.2), sh(0.17), null];
  const out = cleanShafts(list);
  assert.equal(out[3], null);
  assert.ok(out[2] && out[4]);
});
