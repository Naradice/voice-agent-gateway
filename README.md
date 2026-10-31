# Voice Agent Gateway

Android の PTT 音声から ChatGPT(OpenAI API)や Codex などの Agent へ会話を振り分ける Gateway。
設計: `docs/design.md`(元設計書 v0.1 を置く場所)、所見: `docs/design-review.md`。

## 現状: Phase 0A / 0B の着手

| パッケージ | 内容 | 状態 |
|---|---|---|
| `packages/shared` | Router / Session / Decision の共通型 | 完了 |
| `packages/phase0b-router-eval` | オフライン評価ハーネス + ルールのみルーター(方式A) | 動作確認済(dev 12件) |
| `packages/phase0a-codex-probe` | Codex App Server 読み取り専用プローブ | 型チェックのみ。**Windows 実機で未実行** |

## 実行

```bash
npm install
npm run p0b                      # dev セットで評価
npm run p0b -- --split=final     # 最終評価(設定確定後に1回だけ)
npm run p0a                      # Windows + Codex Desktop 上で実行(CODEX_BIN で実行ファイル指定可)
npm run typecheck
```

Node 22.6+ が必要(`--experimental-strip-types` で TS を直接実行)。

## 次の作業

1. 0A: Windows で `npm run p0a` → `out/transcript.json` を元に P0-01/02/06 を判定、メソッド名を実スキーマに合わせる。
   読み取りが通ってから、専用検証スレッドで書き込み試験(P0-03〜05)を追加。
2. 0B: 評価ケース拡充(誤認識文字列・「止めて」等の割り込み含む)→ 方式 B(Embedding)→ C/D(ローカルLLM)。
3. 0A/0B の結果後に Gateway の API(`AgentAdapter`, WebSocket)を確定し Phase 1 へ。
