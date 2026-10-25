# 動画の保存先：Cloudflare R2 の準備

動画は R2（Cloudflare の保存場所）に、解析結果は GitHub に保存します。
R2 の鍵はサイトに置かず、間に立つ Worker（`worker.js`）が合言葉を確かめます。

1. **アカウント**：https://dash.cloudflare.com/sign-up でメールとパスワードを登録し、届いたメールで確認する
2. **R2 を使えるようにする**：左のメニュー「R2 Object Storage」→ 案内に従って有効にする（支払い方法の登録を求められる。無料枠は保存 10GB／月、取り出しは無料）
3. **バケットを作る**：「Create bucket」→ 名前 `oc-form-videos`、場所は Automatic → 作成
4. **Worker を作る**：「Workers & Pages」→「Create」→「Start with Hello World!」→ 名前 `oc-form-video` → Deploy →「Edit code」→ 中身を全部消して `worker.js` を貼り付け → Deploy
5. **バケットを結び付ける**：Worker の「Settings」→「Bindings」→「Add」→「R2 bucket」→ 変数名 `VIDEOS`、バケット `oc-form-videos`
6. **合言葉を入れる**：同じ「Settings」→「Variables and Secrets」→「Add」→ 種類 Secret で
   - `UPLOAD_KEY`：保存用（保存するPCだけが知る。長めの文字列）
   - `VIEW_KEY`：再生用（メンバーに伝える。入れなければ誰でも再生できる）
7. **URL を控える**：Worker の画面に出る `https://oc-form-video.〇〇.workers.dev`
8. **サイトに入れる**：解析ページ「保存の設定」→ Worker の URL・保存用・再生用の合言葉 →「R2の確認」で両方 OK になれば完了
   - スマホなどで見るだけの人は、選手比較ページの「再生用の合言葉」だけを入れる
