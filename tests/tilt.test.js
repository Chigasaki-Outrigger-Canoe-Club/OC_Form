import { test } from "node:test";
import assert from "node:assert/strict";
import { tiltStrokes, sideTilt, fillSides, bestShift, shiftPhases, prepareStrokes } from "../js/tilt.js";
import { P } from "../js/angles.js";

// 肩の傾きだけが動く体（1ストローク＝30フレーム。ストロークの始まりで左肩が下がる。base＝漕ぐ側ごとのふだんの傾き）
function body(frames, base) {
  return Array.from({ length: frames }, (_, f) => {
    const pts = Array.from({ length: 33 }, () => ({ x: 0, y: 1, z: 0, v: 1 }));
    const dip = Math.exp(-(((f % 30) - 5) ** 2) / 8) * 0.05;
    pts[P.lShoulder] = { x: 0.2, y: 1.4 + base(f) / 2 - dip, z: 0, v: 1 };
    pts[P.rShoulder] = { x: -0.2, y: 1.4 - base(f) / 2, z: 0, v: 1 };
    return pts;
  });
}

test("肩の傾きでストロークを区切る（傾きが最も外れた時点）", () => {
  const s = tiltStrokes(body(150, () => 0), 30);
  assert.deepEqual(s.map((x) => x.frame), [5, 35, 65, 95, 125]);
  assert.ok(s.every((x) => x.side === null && x.src === "tilt"));
});

test("漕ぐ側を肩の傾きで決める（基準は漕ぐ側がわかっている動画）", () => {
  const base = (f) => (f < 60 ? 0.1 : -0.1); // 前半は右漕ぎ（左肩が高い）、後半は左漕ぎ
  const known = { body: body(120, base), strokes: [0, 30, 60, 90].map((frame) => ({ frame, side: frame < 60 ? "right" : "left" })).concat({ frame: 119, side: null }) };
  const ref = sideTilt([known]);
  assert.ok(ref.right > 0 && ref.left < 0);
  const back = body(120, base);
  const filled = fillSides(tiltStrokes(back, 30), back, ref);
  // 区切り 5・35・65・95 フレーム。最後の区切りは次がないので決めない
  assert.deepEqual(filled.map((s) => s.side), ["right", "right", "left", null]);
});

test("位相のずれ：曲線が最もよく重なるずらしを探して、一周まわしてずらす", () => {
  const ref = Array.from({ length: 101 }, (_, i) => Math.sin((2 * Math.PI * i) / 100));
  const curve = Array.from({ length: 101 }, (_, i) => Math.sin((2 * Math.PI * (i - 30)) / 100)); // 30点遅れ
  const s = bestShift(curve, ref);
  assert.equal(s, 30);
  const shifted = shiftPhases(curve, s);
  assert.ok(Math.abs(shifted[10] - ref[10]) < 1e-9);
  assert.equal(shifted[100], shifted[0]);
});

test("統合の前の準備：区切れない動画だけ肩の傾きで区切る", () => {
  const b = body(120, () => 0.1);
  const front = { name: "front", body: b, fps: 30, strokes: [{ frame: 0, side: "right" }, { frame: 30, side: "right" }, { frame: 60, side: null }] };
  const back = { name: "back", body: b, fps: 30, strokes: [] };
  const [f, k] = prepareStrokes([front, back]);
  assert.deepEqual(f, front.strokes);
  assert.ok(k.length > 2 && k.every((s) => s.src === "tilt"));
});
