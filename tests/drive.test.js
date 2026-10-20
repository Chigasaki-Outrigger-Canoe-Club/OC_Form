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

test("区切りをキャッチ（ドライブの始まり）に合わせる。手で設定した区切りは動かさない", async () => {
  const { refineToCatch, releaseFrame } = await import("../js/drive.js");
  const body = [...stroke(), ...stroke()]; // 100フレームのストロークが2回（ドライブは40〜79）
  const strokes = [{ frame: 0, side: "right", src: "auto" }, { frame: 100, side: "right", src: "manual" }, { frame: 199, side: null, src: "auto" }];
  const out = refineToCatch(strokes, body);
  assert.ok(Math.abs(out[0].frame - 40) <= 2, `${out[0].frame}`);
  assert.equal(out[1].frame, 100);
  assert.equal(strokes[0].frame, 0, "元の配列は変えない");
  const release = releaseFrame(out, 0, body);
  assert.ok(Math.abs(release - 79) <= 2, `${release}`);
  assert.equal(refineToCatch(strokes, null), strokes);
});

test("最後のストロークが短すぎるときは終端にする", async () => {
  const { refineToCatch } = await import("../js/drive.js");
  const body = [...stroke(), ...stroke(), ...stroke(), ...stroke().slice(0, 60)];
  const strokes = [0, 100, 200, 300, 359].map((frame, n) => ({ frame, side: n < 4 ? "right" : null, src: "auto" }));
  const out = refineToCatch(strokes, body);
  // 4本目は 340 → 359 の短い区間しか残らないので、終端になる
  assert.equal(out.length, 4);
  assert.equal(out.at(-1).side, null);
});
