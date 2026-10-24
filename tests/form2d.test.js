import { test } from "node:test";
import assert from "node:assert/strict";
import { sideFrames, frontBackMetrics, goodStrokes, TORSO_RATIO } from "../js/form2d.js";
import { P } from "../js/angles.js";

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
// 画素の点33個（全部 (0,0)）に、指定した点だけ置く
function frame(points) {
  const f = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 1 }));
  for (const [i, x, y] of points) f[i] = { x, y, v: 1 };
  return f;
}

test("横の2D → 選手基準：顔の向きが前（z+）、胴の長さ＝身長の29%", () => {
  // 画面の左を向いている選手（鼻が腰より左）。胴＝100画素
  const f = frame([[P.nose, 300, 100], [P.lHip, 400, 300], [P.rHip, 400, 300], [P.lShoulder, 400, 200], [P.rShoulder, 400, 200], [P.lWrist, 200, 250]]);
  const [b] = sideFrames([f], 200);
  const scale = (200 * TORSO_RATIO) / 100 / 100; // m／画素
  near(b[P.lWrist].z, 200 * scale);    // 腰より200画素前
  near(b[P.lShoulder].y, 100 * scale); // 腰より100画素上
  near(b[P.lShoulder].z, 0);
});

test("前・後ろ：漕ぐ側の肩が下がる角度・体幹が漕ぐ側へ傾く角度（前と後ろで左右が逆に写る）", () => {
  // 前から：選手の左は画面の右。左肩（画面右）が下がり、肩の中点が画面右へずれる
  const f = frame([[P.lShoulder, 450, 210], [P.rShoulder, 350, 200], [P.lHip, 440, 400], [P.rHip, 360, 400], [P.lWrist, 0, 0], [P.rWrist, 0, 0]]);
  const strokes = [{ frame: 0, side: "left" }, { frame: 10, side: "left" }, { frame: 20, side: null }];
  const pose = Array.from({ length: 21 }, () => f);
  const front = frontBackMetrics({ name: "front", pose, strokes, shaft: null }, "left", null);
  near(front.shoulderTilt, (Math.atan2(10, 100) * 180) / Math.PI);
  near(front.trunkSide, 0);
  // 後ろから：選手の左は画面の左。肩の中点が画面の左へずれる＝左へ傾く → 左漕ぎで正
  const b = frame([[P.lShoulder, 330, 200], [P.rShoulder, 430, 200], [P.lHip, 360, 400], [P.rHip, 440, 400]]);
  const back = frontBackMetrics({ name: "back", pose: Array.from({ length: 21 }, () => b), strokes, shaft: null }, "left", null);
  near(back.trunkSide, (Math.atan2(20, 200) * 180) / Math.PI);
  near(back.hipTilt, 0);
  assert.equal(front.hipTilt, null); // 骨盤は後ろからだけ
});

test("平均に使うストローク：長さが中央値の±25%から外れたもの（休み・見つけ違い）は除く", () => {
  const strokes = [0, 30, 60, 90, 400, 430].map((frame) => ({ frame, side: "right" }));
  assert.deepEqual(goodStrokes(strokes, "right").map((s) => s.frame), [0, 30, 60, 400]);
});
