# Voice Agent Gateway

Android の PTT(押して話す)音声を、Windows 上の Gateway が受け、会話の内容に応じて Agent へ振り分けて、返事を音声で読み上げる。
スマホと PC は Tailscale で結び、Gateway は外部に公開しない。

```
Android(PTT・音声認識・読み上げ) ⇄ WebSocket(Tailscale) ⇄ Gateway ⇄ ┬ ローカルLLM(Ollama。日常会話。既定)
                                                                      ├ Codex Desktop のスレッド(Codex App Server)
                                                                      ├ 検索(SearXNG / Brave。最新情報の質問)
                                                                      └ OpenAI API(任意。実接続は未検証)
```

## 現在の状態(2026-11-01)

| 部分 | 状態 |
|---|---|
| Gateway(`packages/gateway`) | 動作確認済み: ローカルLLMでの会話、WebSocket(認証・再接続・再送)、読み上げ整形、検索(SearXNG)。テスト 106 件。**未確認: Codex への書き込み経由の実運用(利用上限のため)、OpenAI API** |
| Android(`android/`) | 実機(moto g05)で確認済み: 接続、音声認識、読み上げ、画面ロック中・画面OFFの継続、音量下キーの PTT。**未確認: 通知の「話す」ボタン、イヤホンのボタン、長時間の安定性、バッテリー最適化の影響** |
| ローカルLLM | `qwen3-4b-instruct-cpu`(CPU のみ。GPU は使わない)。約 5.4 トークン/秒、初回トークン約 0.4 秒 |
| ルーター(誰に送るか) | ルールのみの方式を評価中(`packages/phase0b-router-eval`)。**現在の Gateway は、まだ会話先を自動では選ばない**(ローカルLLMが既定、Codex は明示的に選ぶ) |
| Codex 連携(Phase 0A) | 読み取り・追記・通知購読は実機で確認。**承認要求の検証(P0-08)は利用上限のため中断中** |

詳細: 実機で確認した事実と未確認は `docs/design-review.md` と `docs/android.md`、設計からの変更点と経緯は `docs/design-changes.md`。

## パッケージ

| パス | 内容 |
|---|---|
| `packages/shared` | Router / Session / Decision の共通型 |
| `packages/gateway` | Gateway 本体。`AgentAdapter`(Codex / ローカルLLM / OpenAI)、SQLite の履歴、WebSocket サーバー、検索、読み上げ整形、CLI |
| `packages/phase0a-codex-probe` | Codex App Server を調べた使い捨てプローブ(読み取り `probe.ts`、書き込み `probe-write.ts`、承認 `probe-approval.ts`) |
| `packages/phase0b-router-eval` | ルーターのオフライン評価(ルール方式、TF-IDF による比較) |
| `android/core` | Android に依存しない Kotlin/JVM。プロトコル、再接続、読み上げキュー、`VoiceController`。テスト 47 件 |
| `android/app` | 画面、フォアグラウンドサービス、音声認識・合成、設定、音量キー/イヤホンの PTT |

## セットアップ(Windows)

前提: Node 22.6+、Ollama、Tailscale(PC とスマホの両方)。Codex 連携を使うなら Codex Desktop。

```bat
git clone https://github.com/Naradice/voice-agent-gateway
cd voice-agent-gateway
npm install
npm run gateway:init
```

`gateway:init` が `.env`(トークンの自動生成、Tailscale の IP の検出を含む)を作る。`.env` は秘密を含むので、コミットもチャットへの貼り付けもしない(`.gitignore` 済み)。**設定は `.env` に保存する。** 同名の環境変数があれば、そちらが優先される(起動時に警告が出る)。

### ローカルLLM(GPU を使わない構成)
```bat
ollama pull qwen3:4b-instruct
npm run ollama:model -- qwen3:4b-instruct
npm run llm -- warm
npm run smoke:local
```
- 2つ目で、GPU の層を 0 にした派生モデル `qwen3-4b-instruct-cpu` を作る(`.env` の `LOCAL_MODEL` が既定でこれ)。`llm warm` が「CPU のみで動いています(VRAM 0)」と表示すれば成功。
- **思考をするモデル(`qwen3:4b` の通常版など)は、思考が本文に出て遅くなる。instruct 版を使うこと**(`docs/design-changes.md` の診断参照)。
- `npm run llm -- status|warm|unload` で、読み込みの確認・先読み・解放ができる(実験の前に `unload`)。

### Gateway の起動とスマホの設定
```bat
npm run gateway
npm run gateway:code
```
`gateway:code` が、スマホに貼る「接続コード」(`ws://<IP>:8787#<トークン>`)と、入力ミスを確かめる**確認コード**(6桁)を表示する。アプリの「設定」で接続コードを貼り付け、「接続テスト」で確かめる。ビルドと実機の手順は `docs/android.md`。

### 主な設定(`.env`)
| 項目 | 内容 |
|---|---|
| `VAG_DEVICES` `VAG_HOST` `VAG_PORT` | 接続を許す端末とトークン、待ち受けの IP とポート |
| `LOCAL_MODEL` `LOCAL_DEVICE` `LOCAL_HISTORY_CHARS` `LOCAL_MAX_TOKENS` `VAG_KEEP_ALIVE` | ローカルLLMとその資源(`LOCAL_DEVICE=cpu` で GPU 使用を警告) |
| `LOCAL_USER_PROFILE` `LOCAL_TIMEZONE` | 居住地など毎回渡す利用者情報、現在日時の表示に使うタイムゾーン |
| `LOCAL_SUPPRESS_THINKING` `LOCAL_CONTEXT` | 思考を止める指定の強制(通常は不要)、文脈長の警告 |
| `SEARCH_PROVIDER` `SEARXNG_URL` `BRAVE_API_KEY` | 最新情報の検索(任意。検索語は外部へ出る場合がある) |
| `CODEX_BIN` | Codex の実行ファイル(Codex 連携を使う場合) |

見本は `.env.example` と `gateway:init` が作るファイル。

## コマンド一覧
| コマンド | 内容 |
|---|---|
| `npm run gateway` / `gateway:init` / `gateway:code` | 起動 / `.env` の作成 / 接続コードと確認コードの表示(`-- --check` でトークンを含まない表示) |
| `npm run gateway:mock` | Android 開発用のモック Gateway(Ollama・Codex 不要) |
| `npm run llm -- status\|warm\|unload` | ローカルLLMの状態確認・先読み・解放 |
| `npm run ollama:model [-- <モデル>]` / `ollama:cpu` | GPU を使わない派生モデルを作る / CPU 専用の Ollama を別ポートで起動(通常は前者で足りる) |
| `npm run smoke:local` / `diagnose:thinking` | ローカルLLMの疎通・速度の確認 / 思考が止まるかの診断 |
| `npm run p0a` `p0a:write` `p0a:approval` | Codex App Server のプローブ(書き込みは専用スレッド `vag-probe…` のみ、`--allow-write` が必要) |
| `npm run p0b` | ルーターの評価(`-- --verbose`、`-- --sweep`、最終評価 `-- --split=final` は1回だけ) |
| `npm test` / `npm run typecheck` | Gateway のテスト(偽 app-server・偽 fetch を使い、Codex も Ollama も不要) / 型検査 |
| `cd android && ./gradlew :core:test` | Android core のテスト(Node が PATH にあること) |

Windows のコマンド例は PowerShell の書き方(`$env:名前="値"`)の箇所がある。cmd.exe では `set 名前=値` に読み替える。

## 画面を見ずに使う(Android)
- **音量下キー:** 画面ロック中・画面OFFでも「話す」になる(アプリの「音量下キーで話す」をオン、端末の「ユーザー補助」で許可)。動作中は音量下で音量を変えられない。戻すにはスイッチをオフ、または通知の「停止」。
- **通知の「話す」ボタン**、**イヤホンのボタン**(再生/一時停止)。これらは未確認。
- 聞き始めはビープ音で分かる。詳細と確認項目は `docs/android.md`。

## ドキュメント
| ファイル | 内容 |
|---|---|
| `docs/protocol.md` | Android ⇄ Gateway の WebSocket プロトコル |
| `docs/android.md` | Android クライアントのビルド・設定・トラブルシューティング・実機での確認項目 |
| `docs/design-changes.md` | 設計書 v0.1 からの変更と、実機で分かったことの経緯 |
| `docs/design-review.md` | 設計レビュー、Phase 0A(Codex)・0B(ルーター)の結果 |

元の設計書 v0.1 は、このリポジトリには入っていない(`docs/design.md` に置く想定)。

## 次の作業
1. Codex: 利用上限の解除後(2026-11-04 15:40 以降)に `npm run p0a:approval` で承認要求の挙動(P0-08)を確認し、Approval Manager を実装する。
2. ルーター: 許容する確認要求率の決定、ローカルLLMによる分類(方式 C/D)、セッション要約。その後 Gateway に組み込み、会話先の自動選択を有効にする。
3. Android: 通知ボタン・イヤホンのボタン・長時間運用の確認。履歴/エラーの表示、トークンの失効の仕組み。
4. 4B モデルの品質が足りなければ、CPU で 7B〜8B の instruct 版を試す(約 2 倍遅くなる)。
