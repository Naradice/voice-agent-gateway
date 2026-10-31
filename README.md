# Voice Agent Gateway

Android の PTT 音声から ChatGPT(OpenAI API)や Codex などの Agent へ会話を振り分ける Gateway。
設計: `docs/design.md`(元設計書 v0.1 を置く場所)、変更点: `docs/design-changes.md`、所見: `docs/design-review.md`、**Android 向けプロトコル仕様: `docs/protocol.md`**、Android クライアント: `docs/android.md`。

## 現状: Phase 0A / 0B の着手

| パッケージ | 内容 | 状態 |
|---|---|---|
| `packages/shared` | Router / Session / Decision の共通型 | 完了 |
| `packages/phase0b-router-eval` | オフライン評価ハーネス + ルールのみルーター(方式A) | 動作確認済(dev 36 / final 20。方式A系と TF-IDF 代用の比較) |
| `packages/gateway` | `AgentAdapter` 共通インターフェース、`CodexAdapter`(貸し出し方式)、`LocalLLMAdapter`(日常会話の既定。Ollama 等の OpenAI 互換)、`OpenAIAdapter`(オプション)、履歴は SQLite。検索層(Brave / SearXNG)、WebSocket サーバー(認証・再接続・再送)、読み上げ整形。偽 Adapter / 偽 app-server / 偽 fetch で76件のテスト | 骨格。実Codex・実LLMでは未実行 |
| `android/` | Android クライアント。`core`(Kotlin/JVM。ビルド・テスト済み、本物の Gateway との結合テストあり)と `app`(画面・サービス・音声認識/合成。**未ビルド**)。詳細は `docs/android.md` | core: 39件通過 / app: 未確認 |
| `packages/phase0a-codex-probe` | Codex App Server プローブ(`probe.ts` 読み取り / `probe-write.ts` 書き込み) | 読み取りは Windows 実機で P0-01/02 合格。書き込みは未実行 |

## 実行

Windows のコマンドは PowerShell の書き方(`$env:名前="値"`)で書いてある箇所がある。cmd.exe では `set 名前=値` に読み替える(`powershell` と入力すれば PowerShell に切り替わる)。トークンなどの秘密は、チャットやリポジトリに貼らない。

```bash
npm install
npm run p0b                      # dev セットで評価(--verbose で全件, --sweep で閾値掃引)
npm run p0b -- --split=final     # 最終評価(設定確定後に1回だけ)
npm run p0a                      # Windows + Codex Desktop 上で実行(CODEX_BIN で実行ファイル指定可)
# 書き込み試験: Desktop で名前が vag-probe で始まる専用スレッドを作り、そのIDを渡す
#   PowerShell: $env:VAG_PROBE_THREAD_ID="<id>"; npm run p0a:write
# 承認要求の検証(P0-08): 既定は decline。許可は $env:VAG_DECISION="accept"
#   npm run p0a:approval
# ローカルLLMの疎通確認(Windows。Ollama 起動済み): npm run smoke:local
#   検索も試す: $env:SEARCH_PROVIDER="brave"; $env:BRAVE_API_KEY="..."  /  "searxng"; $env:SEARXNG_URL="http://127.0.0.1:8080"
# ローカルLLMの状態確認・先読み・解放(GPU を空けたいとき): npm run llm -- status|warm|unload
# Gateway の起動(初回): npm run gateway:init   → .env を作る(トークンを自動生成。Tailscale の IP を検出)
#   以降: npm run gateway          設定は .env から読む(実際の環境変数が優先。.env はコミットされない)
# 接続コード・確認コードの表示(スマホの設定用): npm run gateway:code   (トークンを含まない表示: -- --check)
# Android 開発用のモック Gateway(Ollama・Codex 不要): npm run gateway:mock
npm test                         # Gateway(偽 app-server によるテスト。Codex 不要)
npm run typecheck
```

Node 22.6+ が必要(`--experimental-strip-types` で TS を直接実行)。

## 次の作業

1. 0A: Windows で `npm run p0a` → `out/transcript.json` を元に P0-01/02/06 を判定、メソッド名を実スキーマに合わせる。
   読み取りが通ってから、専用検証スレッドで書き込み試験(P0-03〜05)を追加。
2. 0B: 評価ケース拡充(誤認識文字列・「止めて」等の割り込み含む)→ 方式 B(Embedding)→ C/D(ローカルLLM)。
3. 0A/0B の結果後に Gateway の API(`AgentAdapter`, WebSocket)を確定し Phase 1 へ。
