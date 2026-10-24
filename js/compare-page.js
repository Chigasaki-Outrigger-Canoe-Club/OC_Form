// 選手比較のページ：保存先（GitHub のリポジトリ・ブランチ）を読み、並べる枠を作る
// 見るだけなのでトークンは使わない
import * as github from "./github.js";
import { setupCompare } from "./compare.js";

let settings = { ...github.DEFAULT_SETTINGS };
try { settings = { ...settings, ...JSON.parse(localStorage.getItem(github.SETTINGS_KEY)) }; } catch { /* 保存なし＝既定の保存先 */ }
setupCompare(settings);
