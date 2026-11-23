# Zoom連携 設計書（2026-11-18）

## 結論
**Zoom公式の Realtime Media Streams（RTMS）で「話者名つきの文字起こし」を受け取り、Zoomの表示名で上司／部下を決める。**
声で推定しないので、声が近い2人でも間違えない。Chromeの音声認識も不要になる。

## 方式の比較

| | ① RTMS（おすすめ） | ② Meeting SDK のボット | ③ 録画後の参加者別音声 | ④ 今の方式（声の登録） |
|---|---|---|---|---|
| 仕組み | Zoomのサーバーから、参加者ごとの音声・文字起こしがWebSocketで届く。会議にボットは入らない | ボットが会議に参加して、参加者ごとの生音声を受け取る | クラウド録画の「参加者ごとの音声ファイル」 | 独立PCのマイクで聞き、声の特徴で推定 |
| リアルタイム | ◎ | ◎ | ×（面談後のみ） | ◎ |
| 話者の正確さ | ◎ Zoomの参加者で確定 | ◎ | ◎ | △〜◎ 声による |
| 作る手間 | 中（Webhook受信＋公式SDK） | 大（Linux SDK・音声処理・自前の文字起こし） | 小 | 済 |
| 費用 | 有料プラン＋Developer Pack（従量） | 有料プラン＋サーバー＋文字起こし代 | 有料プラン | 0円 |
| 導入のハードル | 管理者がアプリと共有を許可 | 録音許可が毎回必要 | 録画設定 | なし |

→ 今の目的（その場で言い換える）にはリアルタイムが必須なので③は外す。②は作る量が多い。**①RTMS**を採用し、④は対面・Zoomアカウントなしの時のために残す。

## RTMSで分かっていること（Zoom公式ドキュメントより）
- 2025年6月に一般提供開始。会議にボットを入れずに、参加者ごとの音声・文字起こしを受け取れる
- 文字起こしは参加者ごとに届き、各メッセージに `user_id`・`user_name`・`timestamp` が付く
- 音声は参加者ごと（または全員ミックス）。標準は 16kHz・モノラルの生PCM
- 始まりはWebhookの `meeting.rtms_started`、終わりは `meeting.rtms_stopped`
- 公式SDKあり：Python は `pip install rtms`、Node は `@zoom/rtms`
- 必要なもの：Zoom Marketplace の General app（ユーザー管理型）、RTMSのイベントとスコープ（例 `meeting:read:meeting_transcript`）、アカウントの Developer Pack クレジット、管理者による「会議内容をアプリと共有」の許可
- 料金の目安：開発者フォーラムでは RTMS Stream が約€0.0092/分、文字起こし付きが約€0.0184/分という書き込みがある（Zoomの公式価格ページでは未確認。30分の1on1なら約€0.55）

## 構成

```
Zoom会議（上司・部下・view viewPC）
   │ meeting.rtms_started（Webhook）
   ▼
このアプリのサーバー /zoom/webhook ── 署名を検証・URL確認に応答
   │ rtms.Client().join(payload)
   ▼
Zoom RTMS ── 文字起こし（user_name つき）──▶ /ingest と同じ処理
   │                                              │ Zoomの表示名 → 上司／部下（設定で登録）
   │                                              │ view viewPCの名前は無視
   ▼                                              ▼
                                         /events（SSE）で面談画面へ
                                                  │
                                    いつもの判定（上司の発言だけ）→ view viewが話す
                                                  │
                         view viewの声は、今まで通り独立PCからZoomに流す
```

- **/ingest**：Zoomに限らず「話者名つきの発言」を受け取る入口。模擬データのテストにも使う
- **/events**：面談画面がサーバーから発言を受け取る通り道（Server-Sent Events）
- 面談画面は「Zoom連携」がオンだと、Chromeの音声認識を止め、Zoomからの発言だけを使う

## マンガー（失敗の先回り）
1. **view view自身の声が「発言」として返ってくる** → view viewPCのZoom表示名を無視リストに入れる
2. **表示名が登録と違う**（「山田 太郎」と「山田太郎」など）→ 空白を無視して比べる。知らない名前は「上司?」として表示し、名札クリックで直せる（今の仕組みのまま）
3. **文字起こしが細切れで届く** → 同じ人の発言は 1.2秒途切れるまでまとめてから判定する
4. **Webhookが外から届かない**（PCがインターネットから見えない）→ 開発中は ngrok などで公開URLを作る。本番はサーバーに置くか検討
5. **協力企業の管理者がRTMSを許可しない** → その場合は④（声の登録）か手動切り替えで実施できる

## ダリオ（データと権限）
- Zoom → このアプリ：文字起こしテキスト（参加者名つき）。音声は受け取らない設定にする
- このアプリ → Anthropic：今まで通り、マスキング後のテキストだけ
- ログ：今まで通りこのPC内のみ。発言ごとに「Zoomで確定」と記録する
- Zoom側の録音・文字起こしの扱いは、協力企業のZoom管理者の設定と規約に従う。導入前に管理者の了承を書面でもらう

## サザーランド（範囲）
**今回できたこと（Zoomアカウントなしで確認済みの範囲）**
- `/ingest`・`/events`・面談画面のZoomモード・設定（表示名の登録）
- `/zoom/webhook`（URL確認と署名検証）と RTMS接続コード
- 模擬データで画面が動くことの確認（`tools/zoom_sim.py`）

**未検証（Zoomアカウントが必要）**
- 実際の RTMS 接続（`rtms` SDK の呼び出し方は公式クイックスタートに合わせたが、実機では未確認）

**運営側でやること**
1. Zoomの有料プランで Developer Pack を有効にする
2. Zoom App Marketplace で General app を作り、RTMSのイベント（RTMS Started／Stopped）とスコープ `meeting:read:meeting_transcript` を追加
3. アプリの Client ID / Client Secret / Webhookの Secret Token を `.env` に書く（`ZM_RTMS_CLIENT` / `ZM_RTMS_SECRET` / `ZOOM_WEBHOOK_SECRET_TOKEN`）
4. `pip install rtms` と、ngrok などで `http://127.0.0.1:8001` を公開し、そのURL＋`/zoom/webhook` をイベント通知先に登録
5. アプリの設定で、上司・部下・view viewPCのZoom表示名を登録

## 参考
- Zoom RTMS 一般提供：https://developers.zoom.us/changelog/rtms/june-25-2025/
- RTMS のデータ形式：https://developers.zoom.us/docs/rtms/meetings/media/
- RTMS はじめ方：https://developers.zoom.us/docs/rtms/meetings/getting-started/
- Python クイックスタート：https://github.com/zoom/rtms-quickstart-py
- 料金の書き込み（非公式）：https://devforum.zoom.us/t/rtms-developer-pack-pricing-for-business-account/144203
- Meeting SDK の生データ：https://developers.zoom.us/docs/meeting-sdk/linux/default-ui/advanced-features/raw-data/
