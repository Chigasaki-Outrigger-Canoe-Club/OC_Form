import { test } from "node:test";
import assert from "node:assert/strict";
import { resampleStroke, averageStrokes, viewRepresentative, fuseViews, phaseAt, PHASES } from "../js/fusion.js";
import { toBodyFrame } from "../js/body3d.js";
import { P } from "../js/angles.js";
import { seatedBody, toMediaPipe } from "./helpers.js";

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

// 選手基準の正解の動き：右手首が上下する（1ストローク＝30フレーム）
function truthAt(frame) {
  const b = seatedBody();
  const t = (frame % 30) / 30;
  b[P.rWrist] = { ...b[P.rWrist], y: 0.9 - 0.3 * Math.sin(Math.PI * t), z: 0.5 + 0.2 * t };
  return b;
}

const STROKES = [{ frame: 0, side: "right" }, { frame: 30, side: "right" }, { frame: 60, side: null }];

// angle の方向から撮った動画。腕・脚の奥行き（MediaPipeのz）に誤差を足す
function makeView(angle, depthError, scale = 1) {
  const world = Array.from({ length: 61 }, (_, f) => toMediaPipe(truthAt(f), angle).map((p, j) => {
    const limb = [P.lElbow, P.rElbow, P.lWrist, P.rWrist, P.lKnee, P.rKnee].includes(j);
    return { x: p.x * scale, y: p.y * scale, z: (p.z + (limb ? depthError : 0)) * scale, v: 1 };
  }));
  return { world, body: toBodyFrame(world), strokes: STROKES };
}

const maxError = (frames) => Math.max(...frames.flatMap((f, i) => {
  const truth = truthAt(Math.round((i / (PHASES - 1)) * 29)); // 1ストローク＝フレーム0〜29
  return [P.lElbow, P.rWrist, P.lKnee].map((j) => Math.hypot(f[j].x - truth[j].x, f[j].z - truth[j].z));
}));

test("ストロークの位相そろえ：0%＝開始、100%＝次のストロークの直前のフレーム", () => {
  const body = Array.from({ length: 11 }, (_, f) => [{ x: f, y: 0, z: 0, v: 1 }]);
  const r = resampleStroke(body, 0, 10); // フレーム0〜9（10は次のストロークの始まり）
  assert.equal(r.length, PHASES);
  near(r[0][0].x, 0); near(r[50][0].x, 4.5); near(r[100][0].x, 9);
  body[10] = { bad: true }; // 次のストロークのフレームは使わない
  assert.doesNotThrow(() => resampleStroke(body, 0, 10));
  body[4] = null;
  assert.equal(resampleStroke(body, 0, 10)[50], null);
});

test("位相ごとの平均（欠けた位相は除いて平均）", () => {
  const a = Array.from({ length: PHASES }, () => Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, v: 1 })));
  const b = Array.from({ length: PHASES }, () => Array.from({ length: 33 }, () => ({ x: 2, y: 4, z: 6, v: 0.5 })));
  b[3] = null;
  const avg = averageStrokes([a, b]);
  assert.deepEqual(avg[0][0], { x: 1, y: 2, z: 3, v: 0.75 });
  assert.deepEqual(avg[3][0], { x: 0, y: 0, z: 0, v: 1 });
});

test("見やすさの重み：横から＝左右方向(X)が低い、後ろから＝前後方向(Z)が低い", () => {
  const side = viewRepresentative(makeView(Math.PI / 2, 0));
  near(side.reliability.x, 0.2); near(side.reliability.z, 1); near(side.reliability.y, 1);
  const back = viewRepresentative(makeView(Math.PI, 0));
  near(back.reliability.z, 0.2); near(back.reliability.x, 1);
  assert.equal(side.counts.right, 2);
  assert.equal(side.left, null);
});

test("統合：奥行きの誤差がある2方向を合わせると、どちら単独より正解に近い", () => {
  const left = viewRepresentative(makeView(Math.PI / 2, 0.25));
  const back = viewRepresentative(makeView(Math.PI, 0.25));
  const fused = fuseViews({ left, back });
  const errLeft = maxError(left.right);
  const errBack = maxError(back.right);
  const errFused = maxError(fused.right.frames);
  assert.ok(errFused < 0.5 * Math.min(errLeft, errBack), `統合 ${errFused} / 左 ${errLeft} / 後ろ ${errBack}`);
  assert.deepEqual(fused.right.views, ["left", "back"]);
  assert.deepEqual(fused.right.strokes, { left: 2, back: 2 });
  assert.equal(fused.left, null);
});

test("統合：動画ごとの大きさの違いをそろえる", () => {
  const a = viewRepresentative(makeView(Math.PI / 2, 0, 1));
  const b = viewRepresentative(makeView(Math.PI, 0, 1.5));
  const fused = fuseViews({ a, b });
  const truth = truthAt(0);
  // 1.5倍の動画が混ざっても、胴の長さは平均（1.25倍）にそろい、形は正解の相似形
  const floor = 0.1; // 正解データの足の高さ（床）
  const k = fused.right.frames[0][P.lShoulder].y / (truth[P.lShoulder].y - floor);
  near(fused.right.frames[0][P.lKnee].y / (truth[P.lKnee].y - floor), k, 1e-6);
  near(k, 1.25, 1e-6);
});

test("フレーム → 位相と漕ぐ側", () => {
  assert.deepEqual(phaseAt(0, STROKES), { index: 0, side: "right" });
  assert.deepEqual(phaseAt(15, STROKES), { index: 50, side: "right" });
  assert.deepEqual(phaseAt(45, STROKES), { index: 50, side: "right" });
  assert.equal(phaseAt(60, STROKES), null);
});

test("背中の膨らみ：横からの動画だけを使って位相ごとに平均する", () => {
  const side = makeView(Math.PI / 2, 0);
  side.spine = side.body.map((_, f) => [0, 0.05 + 0.05 * Math.sin((Math.PI * (f % 30)) / 30), 0]);
  const back = makeView(Math.PI, 0);
  back.spine = back.body.map(() => [0, 0.5, 0]); // 後ろからの値は使われないはず
  const fused = fuseViews({ side: viewRepresentative(side), back: viewRepresentative(back) });
  near(fused.right.spine[0][1], 0.05, 1e-6);
  near(fused.right.spine[50][1], 0.1, 0.002);
  // 横からの動画がなければ null
  assert.equal(fuseViews({ back: viewRepresentative(back) }).right.spine, null);
});
