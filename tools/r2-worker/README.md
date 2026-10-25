# 動画の保存先：Cloudflare R2 の準備

GitHub はサイトの表示だけ、データの保存は Cloudflare です。
解析結果・選手データ・動画はすべて R2 に保存します。R2 の鍵はサイトに置かず、間に立つ Worker（`worker.js`）が合言葉を確かめてから保存します。

1. **アカウント**：https://dash.cloudflare.com/sign-up でメールとパスワードを登録し、届いたメールで確認する
2. **R2 を使えるようにする**：左のメニュー「R2 Object Storage」→ 案内に従って有効にする（支払い方法の登録を求められる。無料枠は保存 10GB／月、取り出しは無料）
3. **バケットを作る**：「Create bucket」→ 名前 `oc-form-videos`、場所は Automatic → 作成
4. **Worker を作る**（どちらか）
   - **GitHub と連携（おすすめ）**：「Workers & Pages」→「Create」→「Import a repository」→ GitHub を連携して `OC_Form` を選び、フォルダに `tools/r2-worker` を指定 → Deploy。`wrangler.toml` の設定でバケットも自動で結び付き（手順5は不要）、`worker.js` を直すと自動で作り直される
   - 手で貼る：「Workers & Pages」→「Create」→「Start with Hello World!」→ 名前 `oc-form-video` → Deploy →「Edit code」→ 中身を全部消して `worker.js` を貼り付け → Deploy
5. **バケットを結び付ける**（手で貼った場合だけ）：Worker の「Settings」→「Bindings」→「Add」→「R2 bucket」→ 変数名 `VIDEOS`、バケット `oc-form-videos`
6. **合言葉を入れる**：同じ「Settings」→「Variables and Secrets」→「Add」→ 種類 Secret で
   - `UPLOAD_KEY`：保存用（保存するPCだけが知る。長めの文字列）
   - `VIEW_KEY`：再生用（メンバーに伝える。入れなければ誰でも再生できる）
7. **URL を控える**：Worker の画面に出る `https://oc-form-video.〇〇.workers.dev`
8. **サイト**：「実行」「保存」のときに合言葉（UPLOAD_KEY）を聞かれるので入れる（ブラウザごとに1回）。Worker の URL は最初から入っている
   - スマホなどで見るだけの人は、選手比較ページの「再生用の合言葉」だけを入れる
