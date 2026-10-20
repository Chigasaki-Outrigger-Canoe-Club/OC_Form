// 解析結果をCSVに変換する（ダウンロード処理は main.js）
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
