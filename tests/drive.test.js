import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDrive } from "../js/drive.js";
import { P } from "../js/angles.js";
import { seatedBody } from "./helpers.js";

// 下の手（右）のZ：0〜39 前へ出す（戻し）、40〜79 後ろへ引く（ドライブ）、80〜99 前へ
// 戻しの途中に小さなぶれ（後ろへの短い動き）を入れる
function stroke() {
  const z = (i) => {
    if (i < 40) return 0.2 + (0.4 * i) / 40 + (i >= 10 && i < 14 ? -0.02 * (i - 10) : 0);
    if (i < 80) return 0.6 - (0.6 * (i - 40)) / 40;
    return 0 + (0.2 * (i - 80)) / 20;
  };
  return Array.from({ length: 100 }, (_, i) => {
    const b = seatedBody();
    b[P.rWrist] = { ...b[P.rWrist], z: z(i) };
    return b;
  });
}

test("ドライブ＝下の手が後ろへ引かれている最も長い区間（小さなぶれは含めない）", () => {
  const d = detectDrive(stroke(), "right");
  assert.ok(Math.abs(d.start - 40) <= 2, `start ${d.start}`);
  assert.ok(Math.abs(d.end - 79) <= 2, `end ${d.end}`);
  assert.equal(d.mask[12], false);
  assert.equal(d.mask[60], true);
  assert.ok(Math.abs(d.ratio - 0.4) < 0.05);
});

test("後ろへ動かないときや欠けが多いときは null", () => {
  const still = Array.from({ length: 50 }, () => seatedBody());
  assert.equal(detectDrive(still, "right"), null);
  assert.equal(detectDrive(Array(20).fill(null), "left"), null);
});
