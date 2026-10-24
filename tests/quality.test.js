import { test } from "node:test";
import assert from "node:assert/strict";
import { jointQuality, torsoLength } from "../js/quality.js";
import { P } from "../js/angles.js";

// 胴の長さ 100px の骨格。右手首だけ動かす
function frame(wx, wy, v = 0.9) {
  const f = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 0.9 }));
  f[P.lShoulder] = { x: 60, y: 0, v: 0.9 }; f[P.rShoulder] = { x: 40, y: 0, v: 0.9 };
  f[P.lHip] = { x: 60, y: 100, v: 0.9 }; f[P.rHip] = { x: 40, y: 100, v: 0.9 };
  f[P.rWrist] = { x: wx, y: wy, v };
  return f;
}

test("胴の長さ", () => assert.equal(torsoLength([frame(0, 0)]), 100));

test("跳び・信頼度・正解とのずれ", () => {
  const frames = Array.from({ length: 20 }, (_, n) => frame(n, 50, n < 5 ? 0.3 : 0.9));
  frames[10] = frame(80, 50); // 1フレームだけ大きく外れる → 行きと帰りで2回
  const q = jointQuality(frames, P.rWrist, [], { 3: { [P.rWrist]: { x: 3, y: 60 } } });
  assert.equal(q.jumps, 2);
  assert.equal(q.low, 5 / 20);
  assert.equal(q.errorPx, 10);
  assert.equal(q.error, 10); // 胴の長さ100px → 10%
});

test("同じ位置でのばらつき：同じ動きの繰り返しなら0", () => {
  const frames = Array.from({ length: 61 }, (_, n) => frame(40 + 20 * Math.sin((2 * Math.PI * (n % 20)) / 20), 50));
  const strokes = [0, 20, 40, 60].map((f) => ({ frame: f, side: "right" }));
  const q = jointQuality(frames, P.rWrist, strokes);
  assert.ok(q.spread < 1e-9);
});
