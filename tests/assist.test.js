import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestFrames, frameDoubt } from "../js/assist.js";
import { P } from "../js/angles.js";

const frame = (wristV) => {
  const f = Array.from({ length: 33 }, () => ({ x: 200, y: 300, v: 0.95 }));
  f[P.lShoulder] = { x: 260, y: 200, v: 0.95 };
  f[P.rShoulder] = { x: 140, y: 200, v: 0.95 };
  f[P.lWrist] = { x: 300, y: 400, v: wristV };
  f[P.rWrist] = { x: 100, y: 400, v: 0.95 };
  return f;
};
const hand = (x, y) => ({ s: 0.9, p: [[x, y], [x, y], [x, y]] });

test("自信のなさ：信頼度が低い・手の推定がない・ずれが大きい", () => {
  const good = frameDoubt(frame(0.95), [hand(300, 400), hand(100, 400)]);
  const bad = frameDoubt(frame(0.3), [hand(100, 400)]);
  const left = (list) => list.find((d) => d.label === "左手首").score;
  assert.ok(left(good) < 0.1);
  assert.ok(left(bad) > 1);
});

test("補助するフレーム：自信のない順に、近すぎるフレームを飛ばして選ぶ", () => {
  const pose = Array.from({ length: 100 }, (_, f) => frame(f === 20 || f === 21 || f === 70 ? 0.1 : 0.95));
  const hands = pose.map(() => [hand(300, 400), hand(100, 400)]);
  const strokes = [{ frame: 0, side: "left" }, { frame: 50, side: "right" }, { frame: 99, side: "left" }];
  const picked = suggestFrames(pose, hands, strokes, 30, 2);
  assert.deepEqual(picked.map((p) => p.frame), [20, 70]); // 21 は 20 に近いので飛ばす
  assert.deepEqual(picked[0].weak, ["左手首"]);
});
