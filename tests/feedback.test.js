import { test } from "node:test";
import assert from "node:assert/strict";
import { angle3d, trunkPitch, trunkRotation, sideMetrics, rhythm, buildFeedback, LIMITS } from "../js/feedback.js";
import { PHASES } from "../js/fusion.js";
import { P } from "../js/angles.js";
import { seatedBody } from "./helpers.js";

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

// 体幹の前傾 lean（度）と回旋 twist（度）を与えた姿勢
function pose(lean, twist) {
  const b = seatedBody();
  const t = (twist * Math.PI) / 180;
  const l = (lean * Math.PI) / 180;
  const up = 0.5; // 腰の中点→肩の中点の長さ
  const center = { x: 0, y: 0.5 + up * Math.cos(l), z: up * Math.sin(l) };
  b[P.lHip] = { x: 0.15, y: 0.5, z: 0, v: 1 }; b[P.rHip] = { x: -0.15, y: 0.5, z: 0, v: 1 };
  b[P.lShoulder] = { x: center.x + 0.2 * Math.cos(t), y: center.y, z: center.z + 0.2 * Math.sin(t), v: 1 };
  b[P.rShoulder] = { x: center.x - 0.2 * Math.cos(t), y: center.y, z: center.z - 0.2 * Math.sin(t), v: 1 };
  return b;
}

test("3Dの角度・体幹の前傾・回旋", () => {
  near(angle3d({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), 90);
  near(trunkPitch(pose(0, 0)), 0);
  near(trunkPitch(pose(30, 0)), 30);
  near(trunkRotation(pose(0, 25)), 25);
  near(trunkRotation(pose(0, -25)), -25);
});

// 体幹を 0→maxLean、回旋を 0→maxTwist と動かす代表ストローク
function stroke(maxLean, maxTwist) {
  return Array.from({ length: PHASES }, (_, i) => {
    const k = Math.sin((Math.PI * i) / (PHASES - 1));
    return pose(maxLean * k, maxTwist * k);
  });
}

test("代表ストロークの指標", () => {
  const m = sideMetrics(stroke(30, 20), "right");
  near(m.trunkRange, 30, 1e-6);
  near(m.rotationRange, 20, 1e-6);
  // seatedBody の下の手（右）：肩(-0.2,1.0,0.1)→肘(初期値)→手首。肘の値が出ること
  assert.ok(m.bottomElbow >= 0 && m.bottomElbow <= 180);
  // 上の手(0.1,1.4)→下の手(-0.1,0.9)：左右0.2・上下0.5 → 約21.8°
  near(m.shaftTilt, (Math.atan2(0.2, 0.5) * 180) / Math.PI, 1e-6);
  // 欠けが多いと計算しない
  const broken = stroke(30, 20).map((f, i) => (i % 2 ? null : f));
  assert.equal(sideMetrics(broken, "right"), null);
});

test("リズム：spmとばらつき", () => {
  const even = rhythm([{ fps: 30, strokes: [0, 45, 90, 135].map((frame) => ({ frame })) }]);
  near(even.spm, 40); near(even.cv, 0);
  const uneven = rhythm([{ fps: 30, strokes: [0, 30, 90, 120].map((frame) => ({ frame })) }]);
  assert.ok(uneven.cv > LIMITS.rhythmCV);
  assert.equal(rhythm([{ fps: 30, strokes: [{ frame: 0 }, { frame: 30 }] }]), null);
});

test("コメント：目安から外れた項目と側に印が付く", () => {
  const fused = { right: { frames: stroke(5, 30) }, left: { frames: stroke(30, 5) } };
  const rows = buildFeedback(fused, [{ fps: 30, strokes: [0, 45, 90, 135].map((frame) => ({ frame })) }]);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual(byKey.trunkRange.flagged, ["right"]);
  assert.deepEqual(byKey.rotationRange.flagged, ["left"]);
  assert.deepEqual(byKey.rhythmCV.flagged, []);
  assert.ok(byKey.trunkRange.comment);
  // 片側だけのデータでも動く
  const one = buildFeedback({ right: { frames: stroke(30, 30) }, left: null }, []);
  assert.equal(one.find((r) => r.key === "trunkRange").values.left, null);
});
