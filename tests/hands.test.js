import { test } from "node:test";
import assert from "node:assert/strict";
import { assignHands, pixelScale, correctWorld } from "../js/hands.js";
import { P } from "../js/angles.js";

// 2Dと3Dが「1ピクセル＝0.002m」でそろった骨格（33点）。手首は (左 300,400)・(右 100,400)
function frames() {
  const pose = Array.from({ length: 33 }, () => ({ x: 200, y: 300, v: 0.9 }));
  pose[P.lShoulder] = { x: 260, y: 200, v: 0.9 };
  pose[P.rShoulder] = { x: 140, y: 200, v: 0.9 };
  pose[P.lHip] = { x: 240, y: 400, v: 0.9 };
  pose[P.rHip] = { x: 160, y: 400, v: 0.9 };
  pose[P.lWrist] = { x: 300, y: 400, v: 0.6 };
  pose[P.rWrist] = { x: 100, y: 400, v: 0.6 };
  const world = pose.map((p) => ({ x: (p.x - 200) * 0.002, y: (p.y - 300) * 0.002, z: 0.1, v: p.v }));
  return { pose, world };
}

test("手の専用推定を、近いほうの手首に割り当てる", () => {
  const { pose } = frames();
  const a = assignHands([{ s: 0.9, p: [[110, 390], [0, 0], [0, 0]] }, { s: 0.9, p: [[290, 410], [0, 0], [0, 0]] }], pose);
  assert.deepEqual(a.right[0], [110, 390]);
  assert.deepEqual(a.left[0], [290, 410]);
  // 遠すぎる手（肩幅の0.8倍より遠い）は使わない
  assert.equal(assignHands([{ s: 0.9, p: [[900, 900], [0, 0], [0, 0]] }], pose).left, null);
});

test("1ピクセルあたりのm を肩・腰から求める", () => {
  const { pose, world } = frames();
  assert.ok(Math.abs(pixelScale(pose, world) - 0.002) < 1e-9);
});

test("手の推定の分だけ3Dの手首を動かす（奥行きはそのまま）", () => {
  const { pose, world } = frames();
  const hands = [[{ s: 0.9, p: [[320, 380], [330, 390], [330, 370]] }]];
  const out = correctWorld([world], [pose], hands)[0];
  assert.ok(Math.abs(out[P.lWrist].x - 0.24) < 1e-9); // (320-200)×0.002
  assert.ok(Math.abs(out[P.lWrist].y - 0.16) < 1e-9); // (380-300)×0.002
  assert.equal(out[P.lWrist].z, 0.1);
  assert.equal(out[P.rWrist].x, world[P.rWrist].x); // 右手は推定なし → そのまま
});

test("人が直した点は前後のフレームにも少しずつ広がる", () => {
  const list = Array.from({ length: 9 }, () => frames());
  const pose = list.map((f) => f.pose);
  const world = list.map((f) => f.world);
  pose[4][P.rWrist] = { x: 150, y: 400, v: 1, src: "manual", ox: 100, oy: 400 }; // 右手首を +50px
  const out = correctWorld(world, pose);
  const moved = out.map((f, i) => (f[P.rWrist].x - world[i][P.rWrist].x) / 0.002);
  assert.ok(Math.abs(moved[4] - 50) < 1e-6);
  assert.ok(moved[3] > 40 && moved[3] < 50);
  assert.ok(moved[0] > 0 && moved[0] < moved[3]);
});

test("人が直した点は、同じ漕ぐ側の別のストロークの同じ位置にも効く", () => {
  const list = Array.from({ length: 60 }, () => frames());
  const pose = list.map((f) => f.pose);
  const world = list.map((f) => f.world);
  const strokes = [{ frame: 0, side: "left" }, { frame: 20, side: "right" }, { frame: 40, side: "left" }, { frame: 59, side: "right" }];
  pose[10][P.rWrist] = { x: 150, y: 400, v: 1, src: "manual", ox: 100, oy: 400 }; // 左漕ぎ 50% で右手首を +50px
  const out = correctWorld(world, pose, [], strokes);
  const moved = (n) => (out[n][P.rWrist].x - world[n][P.rWrist].x) / 0.002;
  assert.ok(Math.abs(moved(10) - 50) < 1e-6);
  assert.ok(moved(49) > 25);  // 次の左漕ぎ（40〜58）の約50%（49＝47%）にも効く（位置が少しずれる分だけ弱く）
  assert.ok(Math.abs(moved(30)) < 1e-6);    // 右漕ぎには効かない
});
