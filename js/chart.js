// 時系列グラフ（角度など）を描く。横軸＝フレーム、縦軸＝値
// 値なし（null）の区間は線を切る

const PAD = 36; // 左側の目盛り用の余白

function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function drawChart(canvas, values, currentFrame, strokes) {
  // 表示サイズに合わせて描画サイズを決める（にじみ防止）
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const valid = values.filter((v) => v != null);
  if (!valid.length) {
    ctx.fillStyle = cssColor("--muted");
    ctx.fillText("データがありません", PAD, h / 2);
    return;
  }

  const min = Math.floor(Math.min(...valid));
  const max = Math.ceil(Math.max(...valid));
  const x = (i) => PAD + (i / Math.max(1, values.length - 1)) * (w - PAD - 8);
  const y = (v) => h - 16 - ((v - min) / Math.max(1, max - min)) * (h - 28);

  // ストロークの区切り
  ctx.strokeStyle = cssColor("--border");
  ctx.lineWidth = 1;
  for (const s of strokes) {
    ctx.beginPath();
    ctx.moveTo(x(s.frame), 4);
    ctx.lineTo(x(s.frame), h - 16);
    ctx.stroke();
  }

  // 値の線
  ctx.strokeStyle = cssColor("--accent");
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let drawing = false;
  values.forEach((v, i) => {
    if (v == null) { drawing = false; return; }
    drawing ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v));
    drawing = true;
  });
  ctx.stroke();

  // 現在位置
  ctx.strokeStyle = cssColor("--danger");
  ctx.beginPath();
  ctx.moveTo(x(currentFrame), 4);
  ctx.lineTo(x(currentFrame), h - 16);
  ctx.stroke();

  // 目盛り（最小・最大）
  ctx.fillStyle = cssColor("--muted");
  ctx.font = "11px system-ui";
  ctx.fillText(String(max), 4, y(max) + 4);
  ctx.fillText(String(min), 4, y(min) + 4);
}

// グラフ上のクリック位置 → フレーム番号
export function chartFrameAt(canvas, event, totalFrames) {
  const rect = canvas.getBoundingClientRect();
  const ratio = (event.clientX - rect.left - PAD) / (rect.width - PAD - 8);
  return Math.round(Math.min(Math.max(ratio, 0), 1) * (totalFrames - 1));
}
