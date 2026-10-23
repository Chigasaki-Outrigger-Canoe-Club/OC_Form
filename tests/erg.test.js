import { test } from "node:test";
import assert from "node:assert/strict";
import { parseErgCsv, analyzeErg, toSeconds, resample } from "../js/erg.js";

// Concept2 Logbook のストロークデータに似た CSV（30秒・60本。後半にワットが落ち、心拍が上がる）
function logbookCsv() {
  const rows = ['"Number","Time (seconds)","Distance (meters)","Pace (seconds)","Watts","Cal/Hr","Stroke Rate","Heart Rate"'];
  for (let i = 0; i < 60; i++) {
    const watts = i < 30 ? 200 : 170;
    rows.push([i + 1, (i * 0.5).toFixed(1), i * 5, 110, watts, 900, 52, 140 + i * 0.5].join(","));
  }
  return rows.join("\n");
}

test("Logbook の CSV：列を見出しから判定する", () => {
  const r = parseErgCsv(logbookCsv());
  assert.equal(r.strokes.length, 60);
  assert.deepEqual(r.columns, ["ワット", "ピッチ", "心拍", "ペース", "距離", "時間"]);
  assert.equal(r.strokes[1].time, 0.5);
  assert.equal(r.strokes[0].watts, 200);
});

test("後半の落ちと心拍のずれを改善候補にする", () => {
  const { summary, rows } = analyzeErg(parseErgCsv(logbookCsv()).strokes);
  assert.equal(summary.spm, 52);
  const byLabel = Object.fromEntries(rows.map((r) => [r.label.split("（")[0], r]));
  assert.equal(byLabel["後半の落ち"].flagged, true);
  assert.equal(byLabel["疲れのサイン"].flagged, true);
  assert.match(byLabel["ピッチ"].note, /ハワイアン/);
});

test("力の波形：セルに並んだ数字を読み、へこみを数える", () => {
  const smooth = "10 40 80 100 80 40 10";
  const dipped = "10 60 90 50 95 40 10";
  const csv = ["Time,Watts,Force Curve", `0,200,"${smooth}"`, `1,200,"${dipped}"`, `2,200,"${dipped}"`].join("\n");
  const r = parseErgCsv(csv);
  assert.deepEqual(r.strokes[0].curve, [10, 40, 80, 100, 80, 40, 10]);
  const row = analyzeErg(r.strokes).rows.find((x) => x.label.startsWith("力の波形"));
  assert.equal(row.flagged, true);
});

test("時間の書式とそろえ直し", () => {
  assert.equal(toSeconds("1:52.5"), 112.5);
  assert.equal(toSeconds("95"), 95);
  assert.deepEqual(resample([0, 10], 3), [0, 5, 10]);
});

test("見出しがない CSV は理由を返す", () => {
  assert.ok(parseErgCsv("a,b\n1,2").error);
});

test("pm5_usb.py の CSV：引き・戻し・力の立ち上がりの列を読む", () => {
  const csv = [
    "Number,Time (seconds),Distance (meters),Pace (seconds),Watts,Stroke Rate,Heart Rate,Drive Time (seconds),Recovery Time (seconds),Peak Force (lbs),Average Force (lbs),Force Onset (seconds),Time To Peak (seconds),Force Curve",
    "1,0.05,4.8,119.7,204,52,140,0.4,0.71,110,77.6,0.062,0.234,0 0 9 22 35 47",
  ].join("\n");
  const s = parseErgCsv(csv).strokes[0];
  assert.equal(s.time, 0.05);
  assert.equal(s.driveTime, 0.4);
  assert.equal(s.recoveryTime, 0.71);
  assert.equal(s.onset, 0.062);
  assert.equal(s.toPeak, 0.234);
  assert.equal(s.peakForce, 110);
  assert.equal(s.avgForce, 77.6);
  assert.deepEqual(s.curve, [0, 0, 9, 22, 35, 47]);
});
