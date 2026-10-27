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

// 1件を直す（body＝{ name } や { text }）・消す（body なし）
export async function changeComment(settings, athlete, id, body, fetchFn = fetch) {
  const res = await fetchFn(`${url(settings, athlete)}/${encodeURIComponent(id)}`, {
    method: body ? "PUT" : "DELETE", body: body ? JSON.stringify(body) : undefined,
    headers: { "Content-Type": "application/json", "X-Upload-Key": settings.r2Upload || "" },
  });
  if (!res.ok) throw new Error(`${body ? "直せません" : "消せません"}（${res.status}：${await res.text()}）`);
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
  // メニューの外を押したら、開いているメニューを閉じる
  document.addEventListener("click", (e) => document.querySelectorAll(".comment-menu[open]").forEach((m) => !m.contains(e.target) && (m.open = false)));

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
      comments.forEach((c, n) => list.append(commentItem(athlete, c, n)));
    } catch (err) {
      list.append(Object.assign(document.createElement("p"), { className: "muted", textContent: `コメントを読めません：${err.message}` }));
    }
  }

  // 1件の表示：「番号 名前：日時」と右端のメニュー（⋮）、その下に本文
  const button = (text, className = "btn small") => Object.assign(document.createElement("button"), { className, textContent: text });
  function commentItem(athlete, c, n) {
    const item = Object.assign(document.createElement("div"), { className: "comment" });
    const head = Object.assign(document.createElement("div"), { className: "comment-head" });
    const label = document.createElement("span");
    label.append(`${n + 1} 名前：`, Object.assign(document.createElement("b"), { textContent: c.name }), `：${formatAt(c.at)}`);
    const menu = Object.assign(document.createElement("details"), { className: "comment-menu" });
    const summary = Object.assign(document.createElement("summary"), { textContent: "⋮", title: "メニュー" });
    const items = Object.assign(document.createElement("div"), { className: "comment-menu-items" });
    const [rename, edit, remove] = ["名前変更", "コメント編集", "削除"].map((t) => button(t));
    items.append(rename, edit, remove);
    menu.append(summary, items);
    head.append(label, menu);
    const text = Object.assign(document.createElement("div"), { className: "comment-text", textContent: c.text });
    item.append(head, text);

    // 直す・消すあいだは、その1件をグレーにして操作できないようにする
    const run = async (body) => {
      menu.open = false;
      if (!(await askKey())) return;
      item.classList.add("busy");
      try {
        await changeComment(getSettings(), athlete, c.id, body);
        await render();
      } catch (err) {
        alert(err.message);
        item.classList.remove("busy");
      }
    };
    rename.addEventListener("click", () => {
      const name = prompt("名前", c.name);
      if (name != null && name.trim() !== c.name) run({ name: name.trim() });
    });
    remove.addEventListener("click", () => {
      if (confirm(`${n + 1} のコメントを削除しますか？（元に戻せません）`)) run(null);
    });
    // 編集：本文を入力欄に変え、「保存」で直す
    edit.addEventListener("click", () => {
      menu.open = false;
      const area = Object.assign(document.createElement("textarea"), { className: "btn comment-input", value: c.text, rows: 3, maxLength: 2000 });
      const save = button("保存", "btn small primary");
      const cancel = button("やめる");
      const box = document.createElement("div");
      box.append(area, save, cancel);
      text.replaceWith(box);
      cancel.addEventListener("click", () => box.replaceWith(text));
      save.addEventListener("click", () => {
        if (!area.value.trim() || area.value.trim() === c.text) return box.replaceWith(text);
        save.textContent = "保存中…";
        run({ text: area.value.trim() });
      });
    });
    return item;
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
