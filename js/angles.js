// 関節角度の計算（画像上の2D座標から求める）
// 注意：カメラの向きで値が変わる「画像平面上の角度」。3Dの真の関節角度ではない。
// 信頼度（visibility）が低い点を含む角度は null（表示しない）にする。

// MediaPipe Pose の関節番号
export const P = {
  lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
};

export const MIN_VISIBILITY = 0.5;

// 角度の名前と、計算に使う3点（真ん中の点の角度）
export const ANGLES = {
  leftElbow:     { label: "左肘",   points: [P.lShoulder, P.lElbow, P.lWrist] },
  rightElbow:    { label: "右肘",   points: [P.rShoulder, P.rElbow, P.rWrist] },
  leftShoulder:  { label: "左肩",   points: [P.lHip, P.lShoulder, P.lElbow] },
  rightShoulder: { label: "右肩",   points: [P.rHip, P.rShoulder, P.rElbow] },
  leftHip:       { label: "左股関節", points: [P.lShoulder, P.lHip, P.lKnee] },
  rightHip:      { label: "右股関節", points: [P.rShoulder, P.rHip, P.rKnee] },
  leftKnee:      { label: "左膝",   points: [P.lHip, P.lKnee, P.lAnkle] },
  rightKnee:     { label: "右膝",   points: [P.rHip, P.rKnee, P.rAnkle] },
};

export const TRUNK_LABEL = "体幹の傾き";

// 点bでの角度（度、0〜180）
export function angleAt(a, b, c) {
  const ab = Math.atan2(a.y - b.y, a.x - b.x);
  const cb = Math.atan2(c.y - b.y, c.x - b.x);
  let deg = Math.abs((ab - cb) * 180 / Math.PI);
  if (deg > 180) deg = 360 - deg;
  return deg;
}

export function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(a.v, b.v) };
}

// 体幹の傾き：腰の中点→肩の中点 の線と鉛直線のなす角（度）
// 正＝画像の右側へ傾く、負＝左側へ傾く
export function trunkLean(lm) {
  const shoulder = mid(lm[P.lShoulder], lm[P.rShoulder]);
  const hip = mid(lm[P.lHip], lm[P.rHip]);
  if (shoulder.v < MIN_VISIBILITY || hip.v < MIN_VISIBILITY) return null;
  return Math.atan2(shoulder.x - hip.x, hip.y - shoulder.y) * 180 / Math.PI;
}

// 1フレーム分の全角度 { leftElbow: 95.2, ..., trunk: 12.3 }（値なしは null）
export function computeAngles(lm) {
  const result = {};
  for (const [key, { points }] of Object.entries(ANGLES)) {
    const [a, b, c] = points.map((i) => lm?.[i]);
    const ok = a && b && c && Math.min(a.v, b.v, c.v) >= MIN_VISIBILITY;
    result[key] = ok ? angleAt(a, b, c) : null;
  }
  result.trunk = lm ? trunkLean(lm) : null;
  return result;
}
