import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { angleAt, computeAngles, trunkLean, P } from "../js/angles.js";
import { detectStrokes, findPeaks, smooth, strokeIndexAt } from "../js/strokes.js";
import { readVideoInfo } from "../js/mp4-info.js";
import { buildCSV, buildJSON } from "../js/export.js";
import { rowingPose, rowingSequence } from "./helpers.js";

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

// ---------- 角度 ----------
test("3点の角度：直角・一直線・鋭角", () => {
  near(angleAt({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }), 90);
  near(angleAt({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 180);
  near(angleAt({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }), 45);
});

test("体幹の傾き：まっすぐ＝0度、右へ倒す＝正", () => {
  const lm = rowingPose("left", 0);
  near(trunkLean(lm), 0);
  lm[P.lShoulder].x += 100; lm[P.rShoulder].x += 100; // 肩を胴の長さ分だけ右へ
  near(trunkLean(lm), 45);
});

test("信頼度が低い点を含む角度は null", () => {
  const lm = rowingPose("left", 0);
  lm[P.lElbow].v = 0.2;
  const a = computeAngles(lm);
  assert.equal(a.leftElbow, null);
  assert.equal(a.leftShoulder, null);
  assert.notEqual(a.rightElbow, null);
});

test("人が見つからないフレームは全角度 null", () => {
  const a = computeAngles(null);
  assert.ok(Object.values(a).every((v) => v === null));
});

// ---------- ストローク ----------
test("移動平均と極大の検出", () => {
  assert.deepEqual(smooth([1, null, 3], 1), [1, 2, 3]);
  assert.deepEqual(findPeaks([0, 1, 5, 1, 0, 1, 6, 1, 0], 2), [2, 6]);
});

test("一定ピッチの右漕ぎ：区切りの数と位置、漕ぐ側", () => {
  const fps = 30;
  const period = 45; // 40spm
  const strokes = detectStrokes(rowingSequence(Array(6).fill("right"), period), fps);
  assert.equal(strokes.length, 7);
  strokes.forEach((s, n) => assert.ok(Math.abs(s.frame - n * period) <= 1, `区切り${n}: ${s.frame}`));
  assert.ok(strokes.slice(0, -1).every((s) => s.side === "right"));
  assert.equal(strokes.at(-1).side, null);
});

test("パドルチェンジ：ストロークごとに左右を判定する", () => {
  const sides = ["right", "right", "right", "left", "left", "left"];
  const strokes = detectStrokes(rowingSequence(sides, 40), 30);
  assert.deepEqual(strokes.slice(0, -1).map((s) => s.side), sides);
});

test("検出できないフレームがあっても止まらない", () => {
  const frames = rowingSequence(["left", "left", "left"], 40);
  for (let i = 50; i < 60; i++) frames[i] = null;
  const strokes = detectStrokes(frames, 30);
  assert.ok(strokes.length >= 3);
});

test("フレーム → ストローク番号", () => {
  const strokes = [{ frame: 10 }, { frame: 50 }, { frame: 90 }];
  assert.equal(strokeIndexAt(5, strokes), -1);
  assert.equal(strokeIndexAt(10, strokes), 0);
  assert.equal(strokeIndexAt(89, strokes), 1);
  assert.equal(strokeIndexAt(90, strokes), -1);
});

// ---------- MP4ヘッダ ----------
for (const [file, fps, frames] of [["30fps.mp4", 30, 30], ["25fps.mp4", 25, 50]]) {
  test(`MP4からfpsとフレーム数を読む（${file}）`, () => {
    const buf = readFileSync(new URL(`./fixtures/${file}`, import.meta.url));
    const info = readVideoInfo(new DataView(buf.buffer, buf.byteOffset, buf.byteLength));
    assert.equal(info.fps, fps);
    assert.equal(info.frames, frames);
  });
}

test("MP4でないデータは null", () => {
  assert.equal(readVideoInfo(new DataView(new ArrayBuffer(64))), null);
});

// ---------- 書き出し ----------
test("CSV：1行1フレーム、ストローク番号と漕ぐ側が入る", () => {
  const frames = rowingSequence(["right", "left"], 40);
  const strokes = detectStrokes(frames, 30);
  const lines = buildCSV(frames, 30, strokes).replace("﻿", "").split("\n");
  assert.equal(lines.length, frames.length + 1);
  const header = lines[0].split(",");
  const row = lines[41].split(",");
  assert.equal(row[header.indexOf("stroke_no")], "2");
  assert.equal(row[header.indexOf("side")], "左");
  assert.equal(row[header.indexOf("lWrist_source")], "est");
});

test("JSON：形式名・条件・データを含む", () => {
  const json = buildJSON({ view: "left" }, [null], []);
  assert.equal(json.format, "oc-form-analysis");
  assert.equal(json.view, "left");
  assert.equal(json.frames.length, 1);
  assert.ok(json.notes.angles);
});
