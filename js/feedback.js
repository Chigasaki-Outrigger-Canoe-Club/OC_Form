// フォームの改善点（コメント）
//
// 統合3Dモデル（漕ぐ側ごとの代表ストローク）と、各動画のストローク時間から指標を計算し、
//   1. 目安から外れた項目 →「改善候補」
//   2. 目安の範囲内でも左右差が大きい項目 →「左右差」として、どちらをどう直すかをコメント
//   3. ストロークのリズム → 動画ごと・漕ぐ側ごとの内訳、乱れたストローク、前半と後半の差
// 注意：
// - 目安の根拠は項目ごとに basis で示す（下の SOURCES）。根拠の強さの順：
//     OC研究（アウトリガーの論文）＞ 近い競技の研究（ドラゴンボート）＞ OCの指導資料（クラブ・協会）＞ ボートの考え方の応用 ＞ 暫定
//   OCの研究はまだ少なく（エルゴでの小規模な研究が中心）、確定した「お手本」の数値はない
// - 3Dは1台ずつのカメラの推定を合わせたもので誤差を含む。cm は MediaPipe の推定単位（およそ）
// - 必要な方向の動画がない指標は評価しない（例：シャフトの左右の傾きは前からの動画が必要）
// 目安を変えるときは LIMITS だけを直す。

import { P } from "./angles.js";
import { PHASES } from "./fusion.js";
import { detectDrive } from "./drive.js";
import { spineFlexion } from "./spine.js";

export const LIMITS = {
  trunkRange: 9,       // 体幹の前傾〜起こしの幅（度）。小さいと改善候補。OC研究の平均 9〜17°の下限
  rotationRange: 10,   // 上体の回旋（ねじれ）の幅（度）。小さいと改善候補。OC研究の平均 18〜21°（ばらつき±9°）
  spineRange: 5,       // 背骨の丸まりの変化の幅（度）。小さいと改善候補
  catchFlexion: 25,    // キャッチでの背骨の丸まり（度）。大きいと改善候補
  bottomElbow: 150,    // ドライブ中盤の下の手の肘（度）。小さい（曲がる）と改善候補
  topHand: 5,          // キャッチでの上の手の高さ（肩からcm）。低いと改善候補
  exitBehind: -5,      // 抜きの位置（腰からcm、前が正）。これより後ろだと改善候補
  exitAhead: 25,       // 抜きの位置。これより前だと改善候補（引きが短い）
  shaftTilt: 15,       // ドライブ中盤のシャフトの左右の傾き（度）。大きいと改善候補
  rhythmCV: 5,         // ストローク時間のばらつき（%）。大きいと改善候補
  outlier: 0.08,       // 中央値から8%以上ずれたストロークを「乱れ」として挙げる
  trend: 0.03,         // 前半と後半の平均の差（秒）。これ以上なら挙げる
};

// 根拠の資料（短い名前。詳しい出典は画面の「根拠の資料」に載せている）
export const SOURCES = {
  sealey: "OC研究（Sealey 2011）",
  review: "OC研究レビュー（Canyon & Sealey 2016）",
  gomory: "ドラゴンボート研究（Gomory）",
  guide: "OC指導資料",
  rowing: "ボートの考え方（World Rowing）",
  draft: "暫定（裏付けなし）",
};

const SIDE = { right: "右漕ぎ", left: "左漕ぎ" };
const VIEW = { front: "前", left: "左", right: "右", back: "後ろ" };
const deg = (rad) => (rad * 180) / Math.PI;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const range = (v) => Math.max(...v) - Math.min(...v);
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

// 3D空間での点bの角度（度）
export function angle3d(a, b, c) {
  const u = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const cos = (u.x * v.x + u.y * v.y + u.z * v.z) / (Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z) || 1);
  return deg(Math.acos(Math.min(1, Math.max(-1, cos))));
}

// 体幹の前傾（度）：腰の中点→肩の中点 が鉛直から前（+Z）へ傾く角度
export function trunkPitch(f) {
  const s = mid(f[P.lShoulder], f[P.rShoulder]);
  const h = mid(f[P.lHip], f[P.rHip]);
  return deg(Math.atan2(s.z - h.z, s.y - h.y));
}

// 上体の回旋（度）：上から見た肩の線と腰の線の角度の差
export function trunkRotation(f) {
  const yaw = (l, r) => Math.atan2(l.z - r.z, l.x - r.x);
  let d = deg(yaw(f[P.lShoulder], f[P.rShoulder]) - yaw(f[P.lHip], f[P.rHip]));
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// 1つの側の代表ストロークから指標を計算する
// frames：PHASES 点の骨格、spine：PHASES 点の背中の膨らみ（null 可）、views：統合に使った方向
export function sideMetrics(frames, side, spine = null, views = []) {
  const valid = frames.filter(Boolean);
  if (valid.length < frames.length * 0.8) return null; // 欠けが多いときは計算しない
  const b = side === "right" ? { s: P.rShoulder, e: P.rElbow, w: P.rWrist } : { s: P.lShoulder, e: P.lElbow, w: P.lWrist };
  const top = side === "right" ? P.lWrist : P.rWrist;
  const hipZ = (f) => mid(f[P.lHip], f[P.rHip]).z;
  const cm = (m) => m * 100;

  const drive = detectDrive(frames, side);
  const catchIndex = drive ? drive.start : 0;                       // キャッチ＝ドライブの始まり
  const middle = drive ? Math.round((drive.start + drive.end) / 2) : Math.floor(PHASES / 2);
  const exitIndex = drive ? drive.end : PHASES - 1;                 // 抜き＝ドライブの終わり
  const at = (i) => frames[i] ?? valid[0];

  // ドライブ中の下の手の軌道の乱れ：5点移動平均からのずれ（mm、RMS）
  let pathNoise = null;
  if (drive) {
    // 切り返しの前後2点は除く（向きが変わるところは乱れではない）
    const pts = frames.slice(drive.start + 2, drive.end - 1).filter(Boolean).map((f) => f[b.w]);
    const res = pts.slice(2, -2).map((p, i) => {
      const avg = pts.slice(i, i + 5).reduce((a, q) => ({ x: a.x + q.x / 5, y: a.y + q.y / 5, z: a.z + q.z / 5 }), { x: 0, y: 0, z: 0 });
      return (p.x - avg.x) ** 2 + (p.y - avg.y) ** 2 + (p.z - avg.z) ** 2;
    });
    if (res.length) pathNoise = Math.sqrt(mean(res)) * 1000;
  }

  const flex = spine ? spine.map((p) => spineFlexion(p)).filter((v) => v != null) : [];
  const shaft = { x: at(middle)[b.w].x - at(middle)[top].x, y: at(middle)[b.w].y - at(middle)[top].y };
  const shoulderY = (f) => mid(f[P.lShoulder], f[P.rShoulder]).y;

  return {
    catchLean: trunkPitch(at(catchIndex)),
    catchReach: cm(Math.max(...valid.map((f) => f[b.w].z - hipZ(f)))),
    exitPosition: cm(at(exitIndex)[b.w].z - hipZ(at(exitIndex))),
    topHand: cm(at(catchIndex)[top].y - shoulderY(at(catchIndex))),
    trunkRange: range(valid.map(trunkPitch)),
    rotationRange: range(valid.map(trunkRotation)),
    spineRange: flex.length > PHASES * 0.5 ? range(flex) : null,
    catchFlexion: spine?.[catchIndex] ? spineFlexion(spine[catchIndex]) : null,
    bottomElbow: angle3d(at(middle)[b.s], at(middle)[b.e], at(middle)[b.w]),
    shaftTilt: views.includes("front") ? deg(Math.atan2(Math.abs(shaft.x), Math.abs(shaft.y))) : null,
    driveRatio: drive ? drive.ratio * 100 : null,
    pathNoise,
  };
}

// ---- 項目の定義 ----
// better："high"＝大きいほうがよい、"low"＝小さいほうがよい、null＝方向なし（左右差だけ見る）
// bad：目安から外れたら true、lr：左右差として挙げる差、need：評価できない理由（値が null のとき）
const SIDE_NEED = "カメラ側を漕いだ横からの動画が必要です（右漕ぎ＝右から、左漕ぎ＝左から）";
const FB_NEED = "前か後ろからの動画が必要です";
const ITEMS = [
  { key: "catchLean", basis: ["draft"], label: "キャッチでの前傾（体幹、鉛直から）", unit: "°", better: null, lr: 3, need: SIDE_NEED,
    weak: "キャッチでの前傾の深さが左右で違います。股関節から同じ深さまで倒してください。" },
  { key: "catchReach", basis: ["gomory", "guide"], need: SIDE_NEED, label: "キャッチのリーチ（下の手が腰より前に出る距離）", unit: "cm", better: "high", lr: 5,
    weak: "キャッチで漕ぐ側の肩をもう一段前に出し、股関節から前に倒してリーチを伸ばしてください。" },
  { key: "exitPosition", need: SIDE_NEED, basis: ["guide"], label: "抜きの位置（ドライブの終わり、腰より前が正）", unit: "cm", better: null, lr: 5,
    bad: (v) => v < LIMITS.exitBehind || v > LIMITS.exitAhead,
    comment: (v) => (v < LIMITS.exitBehind
      ? "腰より後ろまで引いています。ブレードが腰の横に来たら抜き、すぐ次のキャッチへ移ってください（後ろまで引くと艇を沈める力になりやすい）。"
      : "早く抜けていて引きが短めです。腰の横まで引き切ってから抜いてください。"),
    weak: "抜く位置が左右でそろうよう、抜きのタイミングを合わせてください。" },
  { key: "topHand", need: SIDE_NEED, basis: ["guide"], label: "キャッチでの上の手の高さ（肩から）", unit: "cm", better: "high", lr: 4,
    bad: (v) => v < LIMITS.topHand,
    comment: () => "キャッチで上の手が低いです。上の手を目の高さ付近まで上げ、下の手の真上に重ねてブレードを立てて入れてください。",
    weak: "キャッチで上の手をもう少し高く保ち、パドルを立ててください。" },
  { key: "trunkRange", need: SIDE_NEED, basis: ["sealey"], label: "体幹の前傾〜起こしの幅", unit: "°", better: "high", lr: 3,
    bad: (v) => v < LIMITS.trunkRange,
    comment: () => "体幹の動きが小さく、腕で引いている可能性があります。キャッチで股関節から前に倒し、ドライブで体幹を起こす力で引いてください。",
    weak: "体幹の前傾〜起こしを大きく使えていません。股関節からの倒し込みを左右でそろえてください。" },
  { key: "rotationRange", need: "上体のねじれは奥行き（3D）が必要なため、動画の画面上の点（2D）では測りません", basis: ["sealey", "guide"], label: "上体の回旋（肩と骨盤のねじれ）の幅", unit: "°", better: "high", lr: 3,
    bad: (v) => v < LIMITS.rotationRange,
    comment: () => "上体のねじれが小さいです。キャッチで漕ぐ側の肩を前に出してねじり、ねじりを戻す力で引いてください。",
    weak: "ねじりが小さくなっています。キャッチで漕ぐ側の肩を前に出す意識を強めてください。" },
  { key: "spineRange", basis: ["draft"], label: "背骨の丸まりの変化（腹直筋・骨盤の動き）", unit: "°", better: "high", lr: 3,
    need: "横からの動画のシルエットが必要です（測れなかったか、横からの動画がありません）",
    bad: (v) => v < LIMITS.spineRange,
    comment: () => "背骨の丸まり方がほとんど変わらず、体幹を固めたまま漕いでいる可能性があります。ドライブで腹筋（腹直筋）を締めて骨盤を起こす動きを確認してください。",
    weak: "腹筋・骨盤の動きが小さくなっています。ドライブで腹筋を締める意識を左右でそろえてください。" },
  { key: "catchFlexion", basis: ["rowing"], label: "キャッチでの背骨の丸まり", unit: "°", better: "low", lr: 4,
    need: "横からの動画のシルエットが必要です",
    bad: (v) => v > LIMITS.catchFlexion,
    comment: () => "キャッチで背中が丸まっています。背中を丸めて手を伸ばすのではなく、背筋を伸ばしたまま股関節から倒してください（ボートでもキャッチは股関節からの前傾が基本。OCではそこに漕ぐ側の肩を前へ出すねじりを加えます）。",
    weak: "キャッチで背中が丸まりやすくなっています。股関節から倒す意識を強めてください。" },
  { key: "bottomElbow", need: SIDE_NEED, basis: ["guide"], label: "ドライブ中盤の下の手の肘", unit: "°", better: "high", lr: 5,
    bad: (v) => v < LIMITS.bottomElbow,
    comment: () => "下の手の肘が曲がり、腕で引いています。下の腕はほぼ伸ばしたまま、体幹のねじり戻しと前傾の起こしで引いてください。",
    weak: "下の手の肘が曲がりやすくなっています。下の腕を伸ばしたまま引く意識を強めてください。" },
  { key: "shaftTilt", basis: ["guide"], label: "ドライブ中盤のシャフトの左右の傾き", unit: "°", better: "low", lr: 4,
    need: "前からの動画がないため評価しません（横・後ろからでは左右の傾きを正しく測れません）",
    bad: (v) => v > LIMITS.shaftTilt,
    comment: () => "シャフトが左右に傾いています。上の手を下の手の真上に重ね、パドルを立てて引いてください。",
    weak: "シャフトが傾きやすくなっています。上の手を艇の外側へ押し出して、パドルを立ててください。" },
  { key: "shoulderTilt", basis: ["draft"], label: "ドライブ中の肩の傾き（漕ぐ側の肩が下がる角度）", unit: "°", better: null, lr: 3, need: FB_NEED,
    weak: "ドライブ中の肩の傾きが左右で違います。漕ぐ側の肩の下げ方（体の沈め方）をそろえてください。" },
  { key: "hipTilt", basis: ["draft"], label: "ドライブ中の骨盤の傾き（漕ぐ側が下がる角度）", unit: "°", better: null, lr: 3, need: "後ろからの動画が必要です",
    weak: "骨盤の傾きが左右で違います。座面に左右均等に座り、片側の骨盤だけが沈まないようにしてください。" },
  { key: "trunkSide", basis: ["draft"], label: "ドライブ中の体幹の左右の傾き（漕ぐ側へ）", unit: "°", better: null, lr: 3, need: FB_NEED,
    weak: "体幹の左右の傾きが左右で違います。漕ぐ側へ倒れ込みすぎていないか、動画で確認してください。" },
  { key: "driveRatio", need: SIDE_NEED, basis: ["sealey"], label: "ドライブ（力を入れている時間）の割合", unit: "%", better: null, lr: 5,
    note: "研究の「推進＝約56%」はブレードが水中にある時間。この値は手が後ろへ速く動いている区間なので定義が違い、直接は比べられません。",
    weak: "ドライブと戻しの時間配分が左右で違います。戻しを急がず、同じリズムで漕いでください。" },
  { key: "pathNoise", need: SIDE_NEED, basis: ["gomory"], label: "ドライブ中の下の手の軌道の乱れ", unit: "mm", better: "low", lr: 3,
    weak: "ドライブ中の手の軌道が乱れています。キャッチからきれいな弧で引き切れているか確認してください（乱れ＝力が抜けている・ブレードがぶれている可能性）。" },
];

const fmt = (v, unit) => `${v.toFixed(1)}${unit}`;

// 左右差のコメント
function lrComment(item, values) {
  const { right, left } = values;
  if (right == null || left == null || Math.abs(right - left) < item.lr) return null;
  const diff = Math.abs(right - left);
  const larger = right > left ? "right" : "left";
  const smaller = larger === "right" ? "left" : "right";
  const weak = item.better === "high" ? smaller : item.better === "low" ? larger : null;
  const head = `左右差 ${fmt(diff, item.unit)}（${SIDE.right} ${fmt(right, item.unit)}／${SIDE.left} ${fmt(left, item.unit)}）。`;
  return weak ? `${head}${SIDE[weak]}のほうが劣っています：${item.weak}` : `${head}${item.weak}`;
}

// ---- リズム（ストローク時間）の内訳 ----
// views：[{ name, fps, strokes }]
export function rhythmDetail(views) {
  const all = [];
  const lines = [];
  for (const v of views) {
    const raw = v.strokes.slice(0, -1).map((s, n) => ({
      no: n + 1, side: s.side, sec: (v.strokes[n + 1].frame - s.frame) / v.fps,
      change: n > 0 && s.side && v.strokes[n - 1].side && s.side !== v.strokes[n - 1].side,
    }));
    // 中央値の2倍を超える区間は休み・区切りの見落としとして除く（ストロークではない）
    const rawMedian = median(raw.map((x) => x.sec));
    const list = raw.filter((x) => x.sec <= rawMedian * 2);
    if (list.length < 3) continue;
    all.push(...list);
    const secs = list.map((x) => x.sec);
    const m = mean(secs);
    const cv = (Math.sqrt(secs.reduce((a, b) => a + (b - m) ** 2, 0) / (secs.length - 1)) / m) * 100;
    lines.push(`${VIEW[v.name] ?? v.name}の動画：${list.length}本、平均 ${m.toFixed(2)}秒（${(60 / m).toFixed(1)} spm）、ばらつき ${cv.toFixed(1)}%`);

    const med = median(secs);
    for (const x of list) {
      if (Math.abs(x.sec - med) / med < LIMITS.outlier) continue;
      const note = x.change ? "、パドルチェンジ直後" : "";
      lines.push(`　No.${x.no}（${SIDE[x.side] ?? "側不明"}${note}）${x.sec.toFixed(2)}秒＝中央値より ${x.sec > med ? "+" : ""}${(x.sec - med).toFixed(2)}秒`);
    }
    const half = Math.floor(secs.length / 2);
    const trend = mean(secs.slice(half)) - mean(secs.slice(0, half));
    if (Math.abs(trend) >= LIMITS.trend) {
      lines.push(`　前半→後半で ${trend > 0 ? "+" : ""}${trend.toFixed(2)}秒（${trend > 0 ? "ペースが落ちています" : "ペースが上がっています"}）`);
    }
  }
  if (!all.length) return null;

  const bySide = Object.fromEntries(["right", "left"].map((s) => [s, all.filter((x) => x.side === s).map((x) => x.sec)]));
  if (bySide.right.length && bySide.left.length) {
    const r = mean(bySide.right);
    const l = mean(bySide.left);
    const slower = r > l ? "右漕ぎ" : "左漕ぎ";
    lines.push(`漕ぐ側ごと：右漕ぎ 平均 ${r.toFixed(2)}秒／左漕ぎ 平均 ${l.toFixed(2)}秒${Math.abs(r - l) >= 0.03 ? `（${slower}が ${Math.abs(r - l).toFixed(2)}秒遅い）` : "（差なし）"}`);
  }
  const secs = all.map((x) => x.sec);
  const m = mean(secs);
  const cv = (Math.sqrt(secs.reduce((a, b) => a + (b - m) ** 2, 0) / (secs.length - 1)) / m) * 100;
  return { cv, spm: 60 / m, count: secs.length, lines };
}

// ピッチ（spm）の位置づけ。研究で比べられた「ハワイアン（55以下）」「タヒチアン（65以上）」との比較
export function rateNote(spm) {
  const style = spm <= 55 ? "ハワイアン（55 spm以下）の範囲" : spm >= 65 ? "タヒチアン（65 spm以上）の範囲" : "ハワイアンとタヒチアンの間";
  return `ピッチ ${spm.toFixed(1)} spm は${style}です。研究ではどちらも同じくらいの速さで、55 spm 前後は体への負担が小さいとされています（エルゴでの研究）。`;
}

// ---- コメントの一覧 ----
// fused：fuseViews の結果、views：[{ name, fps, strokes }]
// 戻り値の各行：{ key, label, unit, values, flagged:[側], comment, lr, reason }
export function buildFeedback(fused, views) {
  const metrics = {
    right: fused.right && sideMetrics(fused.right.frames, "right", fused.right.spine, fused.right.views),
    left: fused.left && sideMetrics(fused.left.frames, "left", fused.left.spine, fused.left.views),
  };
  return feedbackRows(metrics, views);
}

// 指標 { right, left }（sideMetrics や form2d の結果）とストロークから、コメントの一覧を作る
export function feedbackRows(metrics, views) {
  const rows = ITEMS.map((item) => {
    const values = { right: metrics.right?.[item.key] ?? null, left: metrics.left?.[item.key] ?? null };
    const present = Object.entries(values).filter(([, v]) => v != null);
    const flagged = item.bad ? present.filter(([, v]) => item.bad(v)).map(([s]) => s) : [];
    return {
      key: item.key, label: item.label, unit: item.unit, values, flagged, note: item.note ?? null,
      basis: item.basis.map((b) => SOURCES[b]),
      comment: flagged.length ? item.comment(values[flagged[0]]) : null,
      lr: lrComment(item, values),
      reason: present.length ? null : item.need ?? "データが足りないため評価しません",
    };
  });

  const r = rhythmDetail(views);
  rows.push({
    key: "rhythm", label: "ストローク時間のばらつき", unit: "%", values: { all: r?.cv ?? null },
    flagged: r && r.cv > LIMITS.rhythmCV ? ["all"] : [],
    comment: r && r.cv > LIMITS.rhythmCV ? `ばらつきが目安（${LIMITS.rhythmCV}%）より大きいです。下の内訳で乱れたストロークを確認し、特にパドルチェンジの前後でリズムを崩さないようにしてください。` : null,
    lr: null, details: r?.lines ?? [], extra: r ? `平均 ${r.spm.toFixed(1)} spm、${r.count} ストローク` : "",
    note: r ? rateNote(r.spm) : null,
    basis: [SOURCES.sealey, SOURCES.review],
    reason: r ? null : "ストロークが3本以上ある動画がありません",
  });
  return rows;
}
