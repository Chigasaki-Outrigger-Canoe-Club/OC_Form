// 背骨・骨盤の曲がりの推定
//
// MediaPipe の関節点には背骨がなく、肩と腰を直線で結ぶことしかできない。
// そこで、MediaPipe が出す「人物のシルエット（マスク）」から背中の輪郭を測り、
// 背中が直線からどれだけ丸く（または反って）いるかを求める。
//
// 測り方（横から撮った動画で意味がある。前・後ろの動画の値は統合で使わない）：
//   - 腰の中点 H → 肩の中点 S を体幹の軸とする
//   - 軸上の 10%・30%・50%・70%・85% の点から、背中側（顔と反対側）へ直角に進み、
//     シルエットが切れる位置（背中の表面）までの距離を測る
//     （100% の肩の高さは、引きの終わりに腕が背中側に出て邪魔をするので使わない）
//   - 10% と 85% の背中を結ぶ直線から、30%・50%・70% の背中がどれだけ外にあるか
//     → 胴の長さ（H〜S）に対する割合。正＝背中が丸い（屈曲：腹直筋が縮む・骨盤の後傾）、負＝反っている
// これは輪郭からの推定値で、背骨そのものの位置ではない（服・筋肉の厚みの影響を受ける）。

const LEVELS = [0.1, 0.3, 0.5, 0.7, 0.85];
const MASK_LIMIT = 0.5;

// mask：Float32Array（幅 w × 高さ h、0〜1）、lm：MediaPipe の正規化座標（0〜1）の関節点
// 戻り値：[30%, 50%, 70%] の膨らみ（胴の長さ比）。測れないときは null
export function backProfile(mask, w, h, lm) {
  const px = (p) => ({ x: p.x * w, y: p.y * h });
  const S = px({ x: (lm[11].x + lm[12].x) / 2, y: (lm[11].y + lm[12].y) / 2 });
  const H = px({ x: (lm[23].x + lm[24].x) / 2, y: (lm[23].y + lm[24].y) / 2 });
  const N = px(lm[0]);
  const axis = { x: S.x - H.x, y: S.y - H.y };
  const L = Math.hypot(axis.x, axis.y);
  if (L < 20) return null;

  // 顔の向き（体幹の軸のどちら側に鼻があるか）。横向きでなければ測らない
  const normal = { x: -axis.y / L, y: axis.x / L };
  const mid = { x: (S.x + H.x) / 2, y: (S.y + H.y) / 2 };
  const faceSide = (N.x - mid.x) * normal.x + (N.y - mid.y) * normal.y;
  if (Math.abs(faceSide) < L * 0.1) return null;
  const back = faceSide > 0 ? { x: -normal.x, y: -normal.y } : normal;

  const inside = (x, y) => {
    const i = Math.round(y) * w + Math.round(x);
    return x >= 0 && y >= 0 && x < w && y < h && mask[i] >= MASK_LIMIT;
  };

  const depth = LEVELS.map((t) => {
    const start = { x: H.x + axis.x * t, y: H.y + axis.y * t };
    for (let s = 0; s < L * 0.8; s++) {
      if (!inside(start.x + back.x * s, start.y + back.y * s)) return s;
    }
    return null; // 背中の表面が見つからない
  });
  if (depth.some((d) => d == null)) return null;

  const [d0, d30, d50, d70, d85] = depth;
  const line = (t) => d0 + ((d85 - d0) * (t - 0.1)) / (0.85 - 0.1);
  return [[d30, 0.3], [d50, 0.5], [d70, 0.7]].map(([d, t]) => Math.round(((d - line(t)) / L) * 1000) / 1000);
}

// 3Dの背骨の点（腰の中点 → 30% → 50% → 70% → 肩の中点）
// body：選手基準の3D座標、profile：backProfile の値（null なら直線）
export function spinePoints(body, profile) {
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
  const H = mid(body[23], body[24]);
  const S = mid(body[11], body[12]);
  const u = { x: S.x - H.x, y: S.y - H.y, z: S.z - H.z };
  const L = Math.hypot(u.x, u.y, u.z) || 1;
  // 背中の向き：体幹の軸と左右の軸の両方に直角で、後ろ側（選手の前＝+Z の反対）
  const l = { x: body[11].x - body[12].x + body[23].x - body[24].x, y: body[11].y - body[12].y + body[23].y - body[24].y, z: body[11].z - body[12].z + body[23].z - body[24].z };
  let b = { x: u.y * l.z - u.z * l.y, y: u.z * l.x - u.x * l.z, z: u.x * l.y - u.y * l.x };
  const bl = Math.hypot(b.x, b.y, b.z) || 1;
  b = { x: b.x / bl, y: b.y / bl, z: b.z / bl };
  if (b.z > 0) b = { x: -b.x, y: -b.y, z: -b.z };

  const point = (t, d) => ({ x: H.x + u.x * t + b.x * d * L, y: H.y + u.y * t + b.y * d * L, z: H.z + u.z * t + b.z * d * L });
  const p = profile ?? [0, 0, 0];
  return [H, point(0.3, p[0]), point(0.5, p[1]), point(0.7, p[2]), S];
}

// 背骨の曲がり（度）：背中を円弧とみなしたときの、両端の向きの差。正＝丸い、負＝反っている
// 円弧の弦の長さ c と、中央の膨らみ s の関係：曲がりの角度 θ = 4 × atan(2s / c)
// ここでは c＝胴の長さ、s＝50% の膨らみ（胴の長さ比）なので θ = 4 × atan(2 × profile[1])
export function spineFlexion(profile) {
  if (!profile) return null;
  return (4 * Math.atan(2 * profile[1]) * 180) / Math.PI;
}
