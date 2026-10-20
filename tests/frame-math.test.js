// 実行方法：npm test（Node.js 18以上）
import { test } from "node:test";
import assert from "node:assert/strict";
import { timeToFrame, frameToTime, frameCount, clampFrame, formatTime } from "../js/frame-math.js";

test("フレーム → 秒 → フレーム で元に戻る（60fps）", () => {
  for (let f = 0; f < 1200; f++) {
    assert.equal(timeToFrame(frameToTime(f, 60), 60), f);
  }
});

test("秒 → フレーム番号", () => {
  assert.equal(timeToFrame(0, 60), 0);
  assert.equal(timeToFrame(1, 60), 60);
  assert.equal(timeToFrame(0.5, 30), 15);
});

test("20秒・60fpsの動画は1200フレーム", () => {
  assert.equal(frameCount(20, 60), 1200);
  assert.equal(frameCount(0, 60), 1);
});

test("フレーム番号は範囲内に収まる", () => {
  assert.equal(clampFrame(-5, 1200), 0);
  assert.equal(clampFrame(1500, 1200), 1199);
  assert.equal(clampFrame(100, 1200), 100);
});

test("時間の表示形式", () => {
  assert.equal(formatTime(0), "00:00.000");
  assert.equal(formatTime(20), "00:20.000");
  assert.equal(formatTime(75.5), "01:15.500");
});
