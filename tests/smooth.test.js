import { test } from "node:test";
import assert from "node:assert/strict";
import { dropOutliers, fillGaps, gaussian, smoothFrames } from "../js/smooth.js";

test("外れ値を外し、前後から補間する", () => {
  const values = [0, 0.01, 0.02, 0.5, 0.04, 0.05, 0.06]; // 4つ目が跳んでいる
  const kept = dropOutliers(values);
  assert.equal(kept[3], null);
  assert.ok(Math.abs(fillGaps(kept, 5, values)[3] - 0.03) < 1e-9);
});

test("長すぎる穴は補間せず元の値", () => {
  assert.deepEqual(fillGaps([1, null, null, null, 5], 2, [1, 9, 9, 9, 5]), [1, 9, 9, 9, 5]);
});

test("ならす：まっすぐな動きは変えず、ぎざぎざは小さくする", () => {
  const line = [0, 1, 2, 3, 4, 5, 6];
  assert.ok(Math.abs(gaussian(line, 1.5)[3] - 3) < 1e-9);
  const zigzag = [0, 1, 0, 1, 0, 1, 0, 1, 0];
  const s = gaussian(zigzag, 1.5);
  assert.ok(Math.abs(s[4] - 0.5) < 0.1);
});

test("骨格：信頼度の低い点と外れ値を直し、人が直した点は動かさない", () => {
  const frames = Array.from({ length: 20 }, (_, i) => [{ x: i * 0.01, y: 0, z: 0, v: 0.9 }]);
  frames[8][0] = { x: 0.5, y: 0, z: 0, v: 0.9 };        // 外れ値
  frames[12][0] = { x: 0.9, y: 0, z: 0, v: 0.2 };       // 信頼度が低い
  frames[15][0] = { x: 0.2, y: 0, z: 0, v: 1, src: "manual" }; // 人が直した点（外れていても動かさない）
  const out = smoothFrames(frames, 30);
  assert.ok(Math.abs(out[8][0].x - 0.08) < 0.02);
  assert.ok(out[12][0].x > 0.1 && out[12][0].x < 0.16); // 前後から補間（直した点に少し引かれる）
  assert.equal(out[15][0].x, 0.2);
});
