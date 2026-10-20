import { test } from "node:test";
import assert from "node:assert/strict";
import { backProfile, spinePoints, spineFlexion } from "../js/spine.js";
import { seatedBody } from "./helpers.js";

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
const W = 400, H = 400;

// 横向きの人のシルエット：体幹は x=200 の縦線（腰 y=300 → 肩 y=100）、顔は右（+x）
// 背中（左側）の表面は x = 200 − 40 − bulge(y)
function makeMask(bulge) {
  const mask = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = (300 - y) / 200; // 腰0 → 肩1
      const backEdge = 200 - 40 - bulge(t);
      if (t >= -0.2 && t <= 1.2 && x >= backEdge && x <= 260) mask[y * W + x] = 1;
    }
  }
  return mask;
}

function landmarks(faceX = 250) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }));
  lm[11] = lm[12] = { x: 200 / W, y: 100 / H };
  lm[23] = lm[24] = { x: 200 / W, y: 300 / H };
  lm[0] = { x: faceX / W, y: 80 / H };
  return lm;
}

test("背中がまっすぐなら膨らみ 0", () => {
  const p = backProfile(makeMask(() => 0), W, H, landmarks());
  p.forEach((v) => near(v, 0, 0.01));
});

test("背中が丸いと正、中央が最も大きい", () => {
  // 中央で 20px（胴の長さ200pxの10%）膨らむ
  const p = backProfile(makeMask((t) => 20 * Math.sin(Math.PI * t)), W, H, landmarks());
  // 基準線（10%と85%の背中を結ぶ線）も少し膨らんでいるので、その分を引いた値になる
  const b = (t) => 20 * Math.sin(Math.PI * t);
  const expected = (b(0.5) - (b(0.1) + ((b(0.85) - b(0.1)) * 0.4) / 0.75)) / 200;
  near(p[1], expected, 0.006);
  assert.ok(p[1] > p[0] && p[1] > p[2]);
});

test("反っていると負", () => {
  const p = backProfile(makeMask((t) => -15 * Math.sin(Math.PI * t)), W, H, landmarks());
  assert.ok(p[1] < -0.03, `${p[1]}`);
});

test("顔が体幹の軸上（横向きでない）なら測らない", () => {
  assert.equal(backProfile(makeMask(() => 0), W, H, landmarks(201)), null);
});

test("顔が左向きでも、背中側（右）を測る", () => {
  const mask = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 140; x < W; x++) {
    const t = (300 - y) / 200;
    if (t >= -0.2 && t <= 1.2 && x <= 240 + 20 * Math.sin(Math.PI * Math.min(Math.max(t, 0), 1))) mask[y * W + x] = 1;
  }
  const p = backProfile(mask, W, H, landmarks(150));
  assert.ok(p[1] > 0.05, `${p[1]}`);
});

test("3Dの背骨：膨らみ 0 なら腰〜肩の直線上、正なら背中側（−Z）へ出る", () => {
  const body = seatedBody();
  const straight = spinePoints(body, null);
  near(straight[2].z, (straight[0].z + straight[4].z) / 2);
  const round = spinePoints(body, [0.05, 0.1, 0.05]);
  assert.ok(round[2].z < straight[2].z - 0.03);
});

test("背骨の曲がりの角度", () => {
  near(spineFlexion([0, 0, 0]), 0);
  near(spineFlexion([0, 0.1, 0]), (4 * Math.atan(0.2) * 180) / Math.PI);
  assert.ok(spineFlexion([0, -0.1, 0]) < 0);
  assert.equal(spineFlexion(null), null);
});
