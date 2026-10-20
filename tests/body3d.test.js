import { test } from "node:test";
import assert from "node:assert/strict";
import { toBodyFrame, estimatePaddle, cameraBasis, project, bladeOutline } from "../js/body3d.js";
import { readVideoInfo } from "../js/mp4-info.js";
import { P } from "../js/angles.js";
import { seatedBody, toMediaPipe } from "./helpers.js";

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

test("3D：カメラの向きに関係なく、選手の左＝+X、床＝0 にそろう", () => {
  for (const angle of [0, Math.PI / 2, -Math.PI / 2, Math.PI, 0.7]) {
    const body = toBodyFrame([toMediaPipe(seatedBody(), angle)])[0];
    const expected = seatedBody();
    for (const i of [P.lHip, P.rShoulder, P.lKnee, P.rWrist]) {
      near(body[i].x, expected[i].x, 1e-9);
      near(body[i].y, expected[i].y - 0.1, 1e-9); // 足の最も低い点(0.1)が床
      near(body[i].z, expected[i].z, 1e-9);
    }
  }
});

test("3D：人が見つからないフレームは null のまま", () => {
  const result = toBodyFrame([null, toMediaPipe(seatedBody(), 0)]);
  assert.equal(result[0], null);
  assert.ok(result[1]);
});

test("パドル：上の手がグリップ、全長・ブレード位置、漕ぐ側＝下の手", () => {
  const body = seatedBody();
  const size = { length: 1.245, bladeLength: 0.48, bladeWidth: 0.25 };
  const pad = estimatePaddle(body, size);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  assert.deepEqual(pad.grip, { x: 0.1, y: 1.4, z: 0.4 });
  near(dist(pad.grip, pad.tip), 1.245);
  near(dist(pad.bladeStart, pad.tip), 0.48);
  assert.equal(pad.side, "right");
  assert.equal(pad.src, "est");
  // シャフトは下の手を通る
  const toBottom = dist(pad.grip, body[P.rWrist]);
  const t = toBottom / 1.245;
  near(pad.grip.x + (pad.tip.x - pad.grip.x) * t, body[P.rWrist].x);
});

test("パドル：手が見えない・両手が近すぎるときは null", () => {
  const body = seatedBody();
  body[P.lWrist].v = 0.2;
  assert.equal(estimatePaddle(body, { length: 1.2, bladeLength: 0.5, bladeWidth: 0.25 }), null);
  const close = seatedBody();
  close[P.rWrist] = { ...close[P.lWrist], x: close[P.lWrist].x + 0.01 };
  assert.equal(estimatePaddle(close, { length: 1.2, bladeLength: 0.5, bladeWidth: 0.25 }), null);
  assert.equal(estimatePaddle(null, {}), null);
});

test("投影：注視点は画面中央、正面から見ると選手の左(+X)は画面の右", () => {
  const view = { yaw: 0, pitch: 0, distance: 3, target: { x: 0, y: 0.6, z: 0 } };
  const cam = cameraBasis(view);
  const center = project(view.target, cam, 400, 300, 360);
  near(center.x, 200); near(center.y, 150);
  assert.ok(project({ x: 0.3, y: 0.6, z: 0 }, cam, 400, 300, 360).x > 200);
  assert.ok(project({ x: 0, y: 1.0, z: 0 }, cam, 400, 300, 360).y < 150);
  // 後方から見ると左右が逆
  const back = cameraBasis({ ...view, yaw: Math.PI });
  assert.ok(project({ x: 0.3, y: 0.6, z: 0 }, back, 400, 300, 360).x < 200);
  // カメラの後ろの点は描かない
  assert.equal(project({ x: 0, y: 0.6, z: 5 }, cam, 400, 300, 360), null);
});

test("MP4：圧縮形式（H.264）を読み取る", async () => {
  const { readFileSync } = await import("node:fs");
  const buf = readFileSync(new URL("./fixtures/30fps.mp4", import.meta.url));
  assert.equal(readVideoInfo(new DataView(buf.buffer, buf.byteOffset, buf.byteLength)).codec, "avc1");
});

test("ブレードの輪郭：幅と長さが寸法どおり、左右対称、先端が最も下", () => {
  const pts = bladeOutline(0.25, 0.48);
  const xs = pts.map((p) => p.x);
  assert.ok(Math.abs(Math.max(...xs) - 0.125) < 1e-9 && Math.abs(Math.min(...xs) + 0.125) < 1e-9);
  assert.ok(Math.abs(Math.min(...pts.map((p) => p.y)) + 0.48) < 1e-9);
  const tip = pts.find((p) => p.y === -0.48);
  assert.equal(tip.x, 0);
  // 最も広いのは首ではなく先端寄り（長さの半分より下）
  const widest = pts.find((p) => p.x === Math.max(...xs));
  assert.ok(widest.y < -0.24);
  for (const p of pts) assert.ok(pts.some((q) => Math.abs(q.x + p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9));
});

test("パドル：漕ぐ側を渡すと、上の手の高さが入れ替わっても左右が変わらない", () => {
  const body = Array.from({ length: 33 }, () => ({ x: 0, y: 1, z: 0, v: 1 }));
  body[P.lWrist] = { x: 0.2, y: 0.9, z: 0.4, v: 1 }; // 左手（漕ぐ側＝下の手）のほうが高い瞬間
  body[P.rWrist] = { x: 0.1, y: 0.8, z: 0.3, v: 1 };
  const size = { length: 1.2, bladeLength: 0.48, bladeWidth: 0.25 };
  assert.equal(estimatePaddle(body, size, "left").side, "left");
  assert.equal(estimatePaddle(body, size).side, "right"); // 漕ぐ側がわからないときは高さで決める（従来どおり）
});
