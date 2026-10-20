import { test } from "node:test";
import assert from "node:assert/strict";
import { angle3d, trunkPitch, trunkRotation, sideMetrics, rhythmDetail, buildFeedback, LIMITS } from "../js/feedback.js";
import { PHASES } from "../js/fusion.js";
import { P } from "../js/angles.js";
import { seatedBody } from "./helpers.js";

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

// 体幹の前傾 lean（度）・回旋 twist（度）の姿勢
function pose(lean, twist) {
  const b = seatedBody();
  const t = (twist * Math.PI) / 180;
  const l = (lean * Math.PI) / 180;
  const center = { x: 0, y: 0.5 + 0.5 * Math.cos(l), z: 0.5 * Math.sin(l) };
  b[P.lHip] = { x: 0.15, y: 0.5, z: 0, v: 1 }; b[P.rHip] = { x: -0.15, y: 0.5, z: 0, v: 1 };
  b[P.lShoulder] = { x: center.x + 0.2 * Math.cos(t), y: center.y, z: center.z + 0.2 * Math.sin(t), v: 1 };
  b[P.rShoulder] = { x: center.x - 0.2 * Math.cos(t), y: center.y, z: center.z - 0.2 * Math.sin(t), v: 1 };
  return b;
}

// 代表ストローク（右漕ぎ）：0〜49% 戻し（下の手が前へ）、50〜100% ドライブ（後ろへ）
// キャッチ（50%）で前傾・ねじりが最大、下の手は腰より reach m 前、抜きは腰より exit m の位置
function stroke({ lean = 30, twist = 20, reach = 0.6, exit = 0.05 } = {}) {
  return Array.from({ length: PHASES }, (_, i) => {
    const k = i < 50 ? i / 50 : 1 - (i - 50) / 50; // キャッチで1
    const b = pose(lean * k, twist * k);
    const z = i < 50 ? exit + (reach - exit) * (i / 50) : reach - (reach - exit) * ((i - 50) / 50);
    b[P.rWrist] = { x: -0.15, y: 0.8, z, v: 1 };
    b[P.rElbow] = { x: -0.2, y: 0.95, z: z / 2, v: 1 };
    b[P.lWrist] = { x: -0.05, y: 1.3, z: z - 0.1, v: 1 };
    return b;
  });
}

test("3Dの角度・体幹の前傾・回旋", () => {
  near(angle3d({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), 90);
  near(trunkPitch(pose(30, 0)), 30);
  near(trunkRotation(pose(0, 25)), 25);
  near(trunkRotation(pose(0, -25)), -25);
});

test("代表ストロークの指標：リーチ・抜き・上の手・体幹・ドライブの割合", () => {
  const m = sideMetrics(stroke(), "right");
  near(m.catchReach, 60, 0.5);
  assert.ok(Math.abs(m.exitPosition - 5) < 3, `exit ${m.exitPosition}`);
  assert.ok(m.topHand > 20, `top ${m.topHand}`);
  near(m.trunkRange, 30, 0.5);
  near(m.rotationRange, 20, 0.5);
  assert.ok(Math.abs(m.driveRatio - 50) < 6, `drive ${m.driveRatio}`);
  assert.ok(m.pathNoise < 1, "なめらかな軌道は乱れが小さい");
  assert.equal(m.spineRange, null, "背中のデータがなければ null");
});

test("シャフトの傾きは前からの動画があるときだけ", () => {
  assert.equal(sideMetrics(stroke(), "right", null, ["left", "back"]).shaftTilt, null);
  assert.ok(sideMetrics(stroke(), "right", null, ["front"]).shaftTilt > 0);
});

test("背骨の丸まりの変化（腹筋・骨盤）", () => {
  const spine = Array.from({ length: PHASES }, (_, i) => [0, 0.02 + 0.06 * Math.sin((Math.PI * i) / 100), 0]);
  const m = sideMetrics(stroke(), "right", spine);
  assert.ok(m.spineRange > 10, `${m.spineRange}`);
});

const rhythmViews = [{ name: "left", fps: 30, strokes: [0, 40, 80, 120, 160, 200, 240].map((frame, n) => ({ frame, side: n < 3 ? "right" : "left" })) }];

test("コメント：目安の範囲内でも左右差が大きければ、劣っている側を挙げる", () => {
  const fused = { right: { frames: stroke({ twist: 30 }), views: ["left"] }, left: { frames: stroke({ twist: 18 }).map(mirror), views: ["left"] } };
  const rows = Object.fromEntries(buildFeedback(fused, rhythmViews).map((r) => [r.key, r]));
  assert.deepEqual(rows.rotationRange.flagged, []); // どちらも目安（10°）以上
  assert.match(rows.rotationRange.lr, /左漕ぎのほうが劣っています/);
  assert.equal(rows.shaftTilt.values.right, null);
  assert.match(rows.shaftTilt.reason, /前からの動画がない/);
});

test("コメント：目安から外れた項目は改善候補", () => {
  const fused = { right: { frames: stroke({ lean: 5, exit: -0.15 }), views: [] }, left: null };
  const rows = Object.fromEntries(buildFeedback(fused, []).map((r) => [r.key, r]));
  assert.deepEqual(rows.trunkRange.flagged, ["right"]);
  assert.deepEqual(rows.exitPosition.flagged, ["right"]);
  assert.match(rows.exitPosition.comment, /腰より後ろ/);
  assert.equal(rows.rhythm.values.all, null);
});

test("リズムの内訳：動画ごと・乱れたストローク・パドルチェンジ・前半後半・漕ぐ側ごと", () => {
  // 40フレーム（1.33秒）間隔、No.4（パドルチェンジ直後）だけ 52フレーム、後半は少し遅い
  const frames = [0, 40, 80, 120, 172, 214, 256, 298];
  const r = rhythmDetail([{ name: "left", fps: 30, strokes: frames.map((frame, n) => ({ frame, side: n < 3 ? "right" : "left" })) }]);
  const text = r.lines.join("\n");
  assert.match(text, /左の動画：7本/);
  assert.match(text, /No\.4（左漕ぎ、パドルチェンジ直後）1\.73秒/);
  assert.match(text, /前半→後半で \+/);
  assert.match(text, /漕ぐ側ごと：右漕ぎ 平均 1\.33秒／左漕ぎ/);
  assert.ok(r.cv > LIMITS.rhythmCV);
});

// 右漕ぎのストロークを左漕ぎに（左右反転）
function mirror(f) {
  const out = f.map((p) => ({ ...p, x: -p.x }));
  const swap = [[P.lShoulder, P.rShoulder], [P.lElbow, P.rElbow], [P.lWrist, P.rWrist], [P.lHip, P.rHip], [P.lKnee, P.rKnee], [P.lAnkle, P.rAnkle], [P.lEar, P.rEar]];
  for (const [a, b] of swap) [out[a], out[b]] = [out[b], out[a]];
  return out;
}

test("根拠：すべての項目に資料が付く。ピッチの位置づけ", async () => {
  const { rateNote, SOURCES } = await import("../js/feedback.js");
  const fused = { right: { frames: stroke(), views: ["left"] }, left: null };
  for (const row of buildFeedback(fused, rhythmViews)) {
    assert.ok(row.basis.length > 0, row.key);
    for (const b of row.basis) assert.ok(Object.values(SOURCES).includes(b));
  }
  assert.match(rateNote(52), /ハワイアン/);
  assert.match(rateNote(68), /タヒチアン/);
  assert.match(rateNote(60), /間/);
});
