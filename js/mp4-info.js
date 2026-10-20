// MP4ファイルのヘッダから映像のfpsとフレーム数を読む
// 読む場所：映像トラック（hdlr が "vide"）の mdhd（時間の単位と長さ）と stts（フレーム数）
// 読めない形式の場合は null を返す（その場合はfpsを手入力する）

function typeAt(view, pos) {
  return String.fromCharCode(view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3));
}

// ボックス（MP4の入れ物）の一覧
function children(view, start, end) {
  const list = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    let header = 8;
    if (size === 1) { size = Number(view.getBigUint64(pos + 8)); header = 16; }
    if (size === 0) size = end - pos;
    if (size < header) break;
    list.push({ type: typeAt(view, pos + 4), start: pos + header, end: pos + size });
    pos += size;
  }
  return list;
}

function child(view, box, type) {
  return box && children(view, box.start, box.end).find((b) => b.type === type);
}

// view：ファイル全体の DataView
export function readVideoInfo(view) {
  try {
    const root = { start: 0, end: view.byteLength };
    const moov = child(view, root, "moov");
    const traks = children(view, moov.start, moov.end).filter((b) => b.type === "trak");

    for (const trak of traks) {
      const mdia = child(view, trak, "mdia");
      const hdlr = child(view, mdia, "hdlr");
      if (!hdlr || typeAt(view, hdlr.start + 8) !== "vide") continue;

      const mdhd = child(view, mdia, "mdhd");
      const v1 = view.getUint8(mdhd.start) === 1;
      const timescale = view.getUint32(mdhd.start + (v1 ? 20 : 12));
      const units = v1 ? Number(view.getBigUint64(mdhd.start + 24)) : view.getUint32(mdhd.start + 16);

      const stts = child(view, child(view, child(view, mdia, "minf"), "stbl"), "stts");
      const entries = view.getUint32(stts.start + 4);
      let frames = 0;
      for (let i = 0; i < entries; i++) frames += view.getUint32(stts.start + 8 + i * 8);

      const duration = units / timescale;
      return { fps: Math.round((frames / duration) * 1000) / 1000, frames, duration };
    }
  } catch {
    // 形式が想定と違う場合は読めなかった扱い
  }
  return null;
}
