// 選手比較のページ：保存先（GitHub のリポジトリ・ブランチ）を読み、並べる枠を作る
// 見るだけなのでトークンも合言葉も使わない（R2 の動画は誰でも再生できる設定。10/25）
import * as github from "./github.js";
import { setupCompare } from "./compare.js";

let settings = github.loadSettings(localStorage);
setupCompare(settings);
