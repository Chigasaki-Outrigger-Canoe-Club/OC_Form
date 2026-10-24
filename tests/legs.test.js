import { test } from "node:test";
import assert from "node:assert/strict";
import { placeKnee, stabilizeLegs } from "../js/legs.js";
import { P } from "../js/angles.js";
import { seatedBody } from "./helpers.js";

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

test("膝の位置：大腿・下腿の長さを保ち、推定した膝に近い側を選ぶ", () => {
  const hip = { x: 0, y: 0.5, z: 0 };
  const ankle = { x: 0, y: 0.1, z: 0.8 };
  const knee = placeKnee(hip, ankle, { x: 0.05, y: 0.9, z: 0.4 }, 0.45, 0.5);
  near(dist(hip, knee), 0.45); near(dist(knee, ankle), 0.5);
  // 股関節と足首を結ぶ線より上（推定した膝の側）にある
  const below = placeKnee(hip, ankle, { x: 0, y: 0, z: 0.4 }, 0.45, 0.5);
  assert.ok(knee.y > below.y, "推定に近い側を選ぶ");
  // 脚が届かない距離でも長さを保つ（伸びきった位置）
  const far = placeKnee(hip, { x: 0, y: 0.5, z: 2 }, { x: 0, y: 0.6, z: 0.5 }, 0.45, 0.5);
  near(dist(hip, far), 0.45, 1e-3);
});

// 正しい脚の動き（足は固定、膝は少し上下）に、手と重なったときの大きな誤差を入れる
function sequence() {
  return Array.from({ length: 60 }, (_, f) => {
    const b = seatedBody();
    const t = Math.sin((f / 60) * 2 * Math.PI);
    b[P.lHip] = { ...b[P.lHip], z: 0.03 * t };
    if (f >= 20 && f < 25) { // 手と重なって足首・膝が大きくずれる
      b[P.lAnkle] = { ...b[P.lAnkle], y: 0.5, z: 0.4 };
      b[P.lKnee] = { ...b[P.lKnee], y: 0.9, z: 0.2 };
      b[31] = { ...b[31], y: 0.4 };
    }
    return b;
  });
}

test("足首・かかと・つま先は全フレームで同じ位置（ずれたフレームも戻る）", () => {
  const out = stabilizeLegs(sequence());
  const truth = seatedBody();
  for (const f of out) {
    for (const i of [P.lAnkle, 29, 31, P.rAnkle]) {
      near(f[i].x, truth[i].x); near(f[i].y, truth[i].y); near(f[i].z, truth[i].z);
    }
  }
});

test("膝：長さが一定で、ずれたフレームでも正しい位置の近くに戻る", () => {
  const out = stabilizeLegs(sequence());
  const truth = seatedBody();
  const thigh = dist(out[0][P.lKnee], out[0][P.lHip]);
  for (const f of out) near(dist(f[P.lKnee], f[P.lHip]), thigh, 1e-6);
  for (const f of out.slice(20, 25)) assert.ok(dist(f[P.lKnee], truth[P.lKnee]) < 0.05, "膝が大きくずれない");
});

test("人が見つからないフレームはそのまま", () => {
  const frames = sequence();
  frames[5] = null;
  assert.equal(stabilizeLegs(frames)[5], null);
  assert.deepEqual(stabilizeLegs([null, null]), [null, null]);
});

test("足の置き方：かかと同士は拳1個分、膝は内側に入れない", async () => {
  const { setFeet, HEEL_GAP } = await import("../js/legs.js");
  const f = Array.from({ length: 33 }, () => ({ x: 0, y: 0.5, z: 0, v: 1 }));
  f[23] = { x: 0.1, y: 0.5, z: 0, v: 1 };   // 左の股関節
  f[24] = { x: -0.1, y: 0.5, z: 0, v: 1 };  // 右の股関節
  f[25] = { x: -0.02, y: 0.6, z: 0.3, v: 1 }; // 左膝が内側（右寄り）に入っている
  f[26] = { x: -0.15, y: 0.6, z: 0.3, v: 1 };
  for (const [i, x] of [[27, 0.01], [29, 0.01], [31, 0.01], [28, -0.01], [30, -0.01], [32, -0.01]]) f[i] = { x, y: 0.1, z: 0.6, v: 1 };
  const [out] = setFeet([f]);
  assert.ok(Math.abs(out[29].x - out[30].x - HEEL_GAP) < 1e-9);
  assert.ok(Math.abs(out[27].x - out[29].x) < 1e-9); // 足首もかかとと一緒に動く
  assert.ok(out[25].x >= 0.05 - 1e-9);               // 左膝は股関節〜足首の線より外（左）
  assert.equal(out[26].x, -0.15);                    // 右膝はもともと外側 → そのまま
});
