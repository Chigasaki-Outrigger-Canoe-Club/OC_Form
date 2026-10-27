// コメント（掲示板）：選手のフォームへのコメントを、書いた人・本文・日時で残して読めるようにする
// 表示は掲示板（2ch）ふう：「番号 名前：日時」の下に本文。古い順に積み上げる
// 保存先は Cloudflare（Worker の /comments/選手名）。書き込みには保存と同じ合言葉を使う

const NAME_KEY = "oc-form-comment-name"; // 書いた人の名前はこのブラウザに覚えておく（毎回入れなくてよいように）
const el = (id) => document.getElementById(id);
const base = (settings) => (settings.r2Url || "").replace(/\/+$/, "");
const url = (settings, athlete) => `${base(settings)}/comments/${encodeURIComponent(athlete)}`;

export async function fetchComments(settings, athlete, fetchFn = fetch) {
  const res = await fetchFn(url(settings, athlete), { headers: { "X-View-Key": settings.r2View || "" }, cache: "no-store" });
  if (!res.ok) throw new Error(`読めません（${res.status}）`);
  return res.json();
}

export async function postComment(settings, athlete, name, text, fetchFn = fetch) {
  const res = await fetchFn(url(settings, athlete), {
    method: "POST", body: JSON.stringify({ name, text }),
    headers: { "Content-Type": "application/json", "X-Upload-Key": settings.r2Upload || "" },
  });
  if (!res.ok) throw new Error(`書き込めません（${res.status}：${await res.text()}）`);
  return res.json();
}

// 日時の表示：2026/10/27(火) 11:12
const WEEK = "日月火水木金土";
export function formatAt(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}(${WEEK[d.getDay()]}) ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 画面：getSettings＝今の保存の設定、getAthlete＝選んでいる選手の名前、askKey＝合言葉を聞く（なければ false）
export function setupComments({ getSettings, getAthlete, askKey }) {
  try { el("commentName").value = localStorage.getItem(NAME_KEY) ?? ""; } catch { /* 覚えられない環境 */ }

  async function render() {
    const athlete = getAthlete();
    const list = el("commentList");
    el("commentTitle").textContent = athlete ? `${athlete} へのコメント` : "コメント（選手を選ぶと表示）";
    list.replaceChildren();
    if (!athlete) return;
    try {
      const comments = await fetchComments(getSettings(), athlete);
      if (athlete !== getAthlete()) return; // 読んでいる間に選手が変わった
      if (!comments.length) list.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "まだコメントはありません" }));
      comments.forEach((c, n) => {
        const item = document.createElement("div");
        item.className = "comment";
        const head = Object.assign(document.createElement("div"), { className: "comment-head" });
        head.append(`${n + 1} 名前：`, Object.assign(document.createElement("b"), { textContent: c.name }), `：${formatAt(c.at)}`);
        item.append(head, Object.assign(document.createElement("div"), { className: "comment-text", textContent: c.text }));
        list.append(item);
      });
    } catch (err) {
      list.append(Object.assign(document.createElement("p"), { className: "muted", textContent: `コメントを読めません：${err.message}` }));
    }
  }

  // 書き込み中は、名前・コメント・ボタンをグレーにして操作できないようにする
  const setBusy = (on) => {
    ["commentName", "commentText", "commentPost"].forEach((id) => (el(id).disabled = on));
    el("commentPost").textContent = on ? "書き込み中…" : "書き込む";
  };

  el("commentPost").addEventListener("click", async () => {
    const athlete = getAthlete();
    const text = el("commentText").value.trim();
    if (!athlete || !text) return;
    if (!(await askKey())) return;
    const name = el("commentName").value.trim();
    try { localStorage.setItem(NAME_KEY, name); } catch { /* 覚えられない環境 */ }
    setBusy(true); // 反映されるまで押せないようにする（二重に書き込まないため）
    try {
      await postComment(getSettings(), athlete, name, text);
      el("commentText").value = "";
      await render();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  });

  return { render };
}
