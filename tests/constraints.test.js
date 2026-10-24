import { test } from "node:test";
import assert from "node:assert/strict";
import { plausibleBody, plausibleShaft, clampLean, LIMITS } from "../js/constraints.js";
import { P } from "../js/angles.js";
import { seatedBody } from "./helpers.js";

const deg = (r) => (r * 180) / Math.PI;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

test("胴の傾き：前へ倒れすぎた分だけ戻す", () => {
  const v = clampLean({ x: 0, y: 0.2, z: 1 }, LIMITS.leanForward, LIMITS.leanBack, LIMITS.leanSide); // 約79°前傾
  assert.ok(Math.abs(deg(Math.atan2(v.z, v.y)) - LIMITS.leanForward) < 1e-6);
  const ok = { x: 0, y: 1, z: 0.3 };
  assert.equal(clampLean(ok, 60, 30, 30), ok); // 範囲内はそのまま
});

test("腕が急に伸びたフレームを、ふだんの腕の長さに戻す", () => {
  const frames = Array.from({ length: 9 }, () => seatedBody());
  const normal = Math.hypot(...["x", "y", "z"].map((a) => frames[0][P.rWrist][a] - frames[0][P.rElbow][a]));
  frames[4] = seatedBody();
  frames[4][P.rWrist] = { ...frames[4][P.rWrist], z: frames[4][P.rWrist].z + 0.5 }; // 前腕が50cm伸びた（誤り）
  const out = plausibleBody(frames);
  const fixed = Math.hypot(...["x", "y", "z"].map((a) => out[4][P.rWrist][a] - out[4][P.rElbow][a]));
  assert.ok(Math.abs(fixed - normal) < 1e-6);
});

test("頭が胴に対して曲がりすぎていたら戻す", () => {
  const f = seatedBody();
  const sh = mid(f[P.lShoulder], f[P.rShoulder]);
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) f[i] = { ...f[i], x: sh.x, y: sh.y, z: sh.z + 0.15 }; // 頭が真横（前）に
  const [out] = plausibleBody([f]);
  const hip = mid(out[P.lHip], out[P.rHip]);
  const s = mid(out[P.lShoulder], out[P.rShoulder]);
  const e = mid(out[P.lEar], out[P.rEar]);
  const t = { x: s.x - hip.x, y: s.y - hip.y, z: s.z - hip.z };
  const n = { x: e.x - s.x, y: e.y - s.y, z: e.z - s.z };
  const angle = deg(Math.acos((t.x * n.x + t.y * n.y + t.z * n.z) / (Math.hypot(t.x, t.y, t.z) * Math.hypot(n.x, n.y, n.z))));
  assert.ok(angle <= LIMITS.head + 0.5, `${angle}`);
});

test("パドル：ブレードは上の手より下、漕ぐ側から反対へ行きすぎない", () => {
  const up = plausibleShaft({ x: 0, y: 0.5, z: 0.866 }, "left"); // 上を向いた（誤り）
  assert.ok(Math.abs(up.y - LIMITS.shaftUp) < 1e-9);
  const cross = plausibleShaft({ x: -0.8, y: -0.6, z: 0 }, "left"); // 左漕ぎなのに右へ大きく
  assert.ok(Math.abs(cross.x + LIMITS.shaftCross) < 1e-9);
  assert.ok(Math.abs(Math.hypot(cross.x, cross.y, cross.z) - 1) < 1e-9);
  const fine = { x: 0.3, y: -0.9, z: 0.3 };
  assert.deepEqual(plausibleShaft(fine, "left"), fine); // 範囲内はそのまま
});
