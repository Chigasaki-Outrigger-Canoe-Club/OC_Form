// 解析結果をCSV・JSONに変換する（ダウンロード処理は main.js）
// データの種類を区別して書き出す：
//   関節座標＝推定値（MediaPipe）または手動修正、角度＝関節座標からの計算値（画像平面上）

import { ANGLES, P, computeAngles } from "./angles.js";
import { strokeIndexAt } from "./strokes.js";

const SIDE = { left: "左", right: "右" };
const fix = (n, d) => (n == null ? "" : n.toFixed(d));

// 1行1フレームのCSV（Excelで開けるよう先頭にBOMを付ける）
export function buildCSV(frames, fps, strokes) {
  const angleKeys = [...Object.keys(ANGLES), "trunk"];
  const jointNames = Object.keys(P);
  const header = [
    "frame", "time_s", "stroke_no", "side",
    ...angleKeys.map((k) => `${k}_deg`),
    ...jointNames.flatMap((n) => [`${n}_x_px`, `${n}_y_px`, `${n}_visibility`, `${n}_source`]),
  ];

  const rows = frames.map((lm, f) => {
    const n = strokeIndexAt(f, strokes);
    const angles = computeAngles(lm);
    return [
      f, fix(f / fps, 3), n < 0 ? "" : n + 1, n < 0 ? "" : SIDE[strokes[n].side] ?? "",
      ...angleKeys.map((k) => fix(angles[k], 1)),
      ...jointNames.flatMap((name) => {
        const p = lm?.[P[name]];
        return p ? [p.x, p.y, p.v, p.src] : ["", "", "", ""];
      }),
    ].join(",");
  });

  return "﻿" + [header.join(","), ...rows].join("\n");
}

// 解析条件と全データを含むJSON
export function buildJSON(meta, frames, strokes, world = null) {
  return {
    format: "oc-form-analysis",
    version: 1,
    createdAt: new Date().toISOString(),
    ...meta,
    notes: {
      coordinates: "画像上のピクセル座標（左上が原点、yは下向き）",
      visibility: "MediaPipeの信頼度（0〜1）。0.5未満の点を含む角度は計算しない",
      source: "est＝MediaPipeによる推定値、manual＝手動修正",
      angles: "2D画像平面上の角度。カメラの向きにより真の関節角度とは異なる",
      strokes: "区切り＝手が最も高い時点（自動検出）。side＝その区切りから次の区切りまでの漕ぐ側",
      world: "MediaPipeの3D推定座標（腰の中心が原点、単位およそm、x右・y下・z奥）。1台のカメラからの推定値で、奥行きの精度は低い",
    },
    strokes,
    frames,
    world,
  };
}
