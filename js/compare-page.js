// 選手比較のページ：保存先（GitHub のリポジトリ・ブランチ）を読み、並べる枠を作る
// 見るだけなのでトークンは使わない（R2 の動画は再生用の合言葉で読む）
import * as github from "./github.js";
import { setupCompare } from "./compare.js";

let settings = github.loadSettings(localStorage);
// 再生用の合言葉（R2 に動画を置いているとき）。入れたらこのブラウザに保存し、一覧を読み直す
const viewKey = document.getElementById("compareViewKey");
viewKey.value = settings.r2View ?? "";
viewKey.addEventListener("change", () => {
  settings = { ...settings, r2View: viewKey.value.trim() };
  try { localStorage.setItem(github.SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 保存できない環境 */ }
  location.reload();
});
setupCompare(settings);
