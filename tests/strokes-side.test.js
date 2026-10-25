import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStrokes, cameraSide } from "../js/strokes.js";
import { P } from "../js/angles.js";

// 横から撮った動画：手前の左手首だけが見え、奥の右手首はほとんど隠れている（1ストローク＝30フレーム）
function sideView(frames) {
  return Array.from({ length: frames }, (_, f) => {
    const pts = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 1 }));
    pts[P.lShoulder] = pts[P.rShoulder] = { x: 0, y: 100, v: 1 };
    pts[P.lHip] = pts[P.rHip] = { x: 0, y: 300, v: 1 };
    pts[P.lWrist] = { x: 0, y: 250 + 100 * Math.sin((2 * Math.PI * f) / 30), v: 1 };
    pts[P.rWrist] = { x: 0, y: 200, v: f % 4 === 0 ? 0.9 : 0.1 }; // 見えるのは4フレームに1回
    return pts;
  });
}

test("横の動画：奥の手首が隠れていても、見えている手首でストロークを区切る", () => {
  const strokes = detectStrokes(sideView(300), 30);
  assert.ok(strokes.length >= 9, `区切り ${strokes.length}`);
  const gaps = strokes.slice(1).map((s, n) => s.frame - strokes[n].frame);
  assert.ok(gaps.every((g) => Math.abs(g - 30) <= 1), gaps.join(" "));
});

test("横の動画で漕ぐ側がわからないストロークは、カメラ側とみなす（前・後ろはそのまま）", () => {
  const strokes = [{ frame: 0, side: null }, { frame: 30, side: "right" }, { frame: 60, side: null }];
  assert.deepEqual(cameraSide(strokes, "left").map((s) => s.side), ["left", "right", null]);
  assert.deepEqual(cameraSide(strokes, "front"), strokes);
});
