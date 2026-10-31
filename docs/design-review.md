# 設計レビュー (v0.1 に対する所見)

## 決定事項 (2026-10-31)

1. **Codex が C 判定の場合:** 読み取り専用で運用する。続きの作業は、有料 AI で引継ぎ資料を作成して新規セッションへ移行する。
2. **割り込み等の特定キーワード:** Gateway のルールエンジンで扱えるようにする。具体的な語彙と動作は今後詰める。
3. **走行中の承認判定:** Gateway の Approval Manager に集約する。
4. **STT 誤認識:** Phase 0B の評価データに誤認識文字列を含める。

設計書は責任分界・段階的検証・安全側の既定が揃っており、そのまま着手可能。以下は着手前に決めておくと手戻りが減る点。

## 要判断(ブロッカーではない)

1. **Codex 連携が C 判定のときの代替案を先に決める。**
   候補: (a) Gateway 管理の新規 Codex セッション(`codex exec` / SDK 経由)、(b) 読み取り専用(履歴参照・進捗読み上げのみ)。
   Phase 1 の範囲が変わるので、0A の結果待ちにしない。
2. **STT の方針。** Android `SpeechRecognizer` は端末依存・オンデバイス対応差が大きい。
   日本語の技術用語(JEPA, Codex 等)の認識精度が Router の入力品質を左右する。
   Phase 0B の評価データは「正しい文字列」だけでなく「誤認識された文字列」も含めるべき。
3. **ローカル LLM の実行場所。** Windows GPU 有無で 5.5 のモデル候補が変わる。0B 開始前に実機スペックを確定。
4. **Gateway 常駐と Codex Desktop の同居。** 同じ Windows 上で Codex Desktop と App Server を併用する場合、
   プロセス/ロックの競合は P0-05 で最優先に見る。

## 設計書の穴

- **ターン境界・割り込みの音声 UX:** 「Agent 処理中も IDLE」と「interrupt」の発話を、
  Router が通常指示と区別する規則(「止めて」等)が未定義。ルールエンジンの最優先に置くことを推奨。
- **認証の具体:** Tailscale に加えデバイス認証とあるが、方式(デバイス登録時の長寿命トークン / mTLS 等)が未記載。
- **走行中の安全 (原則9) の強制箇所:** Android 側の状態 or Gateway の Approval Manager のどちらが
  「停止時のみ承認可」を判定するかが未定義。Gateway に集約するのが Agent 非依存の原則に合う。
- **Embedding のオフライン評価:** 0B の方式 B/D はモデル選定が必要。日本語対応の小型モデルを 2〜3 個候補化。

## Phase 0B 初回ベースライン(方式A: ルールのみ、dev 12 件)

| 指標 | 値 |
|---|---|
| Agent Accuracy | 100% |
| Session Accuracy | 100% (5/5) |
| **Wrong Dispatch Rate** | **16.7% (2/12)** |
| Confirmation Rate | 16.7% |

誤配送 2 件はいずれも「同一テーマが ChatGPT と Codex の両方にあり、キーワード数だけで片方を選んだ」ケース
(「JEPAの実験について相談したい」「実験結果を確認して」)。設計書が重視する条件そのものが、
ルールのみでは危険であることを示している。→ 方式 B/C/D の比較動機になる。
`data/final.json` は未使用(閾値確定後に 1 回だけ実行する)。
dev は 12 件と少なく、統計的結論は出さない。ケースの拡充が最初の仕事。

## 検証していない前提

- `phase0a-codex-probe` の App Server メソッド名(`thread/list` 等)は **未検証**。この環境に Codex が無く実行していない。
  Windows 実機で公式スキーマと突き合わせること。

## Phase 0A 実測結果 (Windows 実機, Codex Desktop / app-server)

| ID | 結果 | 根拠・限定 |
|---|---|---|
| P0-01 既存スレッドの発見 | 合格 | `thread/list` で Desktop の 13 スレッドを取得(`source: vscode`) |
| P0-02 履歴の正確な取得 | 合格(限定付き) | 1 スレッド・1 ターンで、ページング取得 78 件が一括取得と ID 集合で完全一致(欠落0・余剰0・重複0)。複数ターンのスレッド、本文と Desktop 表示の一致は未確認 |
| P0-03 同一スレッドへの追記 | 合格(条件付き) | Desktop 完全終了 / Desktop 再起動後に当該スレッドを開かない状態では `thread/resume` → `turn/start` が成功。Desktop が当該スレッドをロードした状態のままの起動中は `already has an active writer` で拒否 |
| P0-04 デスクトップへの反映 | 合格(限定付き) | 書き込み後に Desktop でスレッドを開くと、指示と返答が表示された。Desktop がスレッドを開いたまま反映されるか、再起動が不要かは、ロックにより試験不能 |
| P0-05 排他・競合制御 | 合格(限定付き) | 書き込み権は1プロセスのみで双方向に有効。Gateway が保持中に Desktop で開くと「別のアプリで開いています。ここで続けるには、あちらで閉じてください」と表示され、Desktop 側は書き込めない。履歴破損の兆候は見ていない。保持中も履歴は Desktop で読める。プロセス終了後は、Desktop を閉じずにセッションを切り替える(開き直す)だけで自動的に継続可能に戻った |
| P0-06 イベント購読 | 合格 | resume したプロセスで turn/started, item/started, item/agentMessage/delta, item/completed, turn/completed, thread/status/changed, thread/tokenUsage/updated を受信。Desktop 側で開始されたターンの通知を受け取れるかは未確認 |
| P0-07, 08 | 未検証 | 再起動・再接続、権限・履歴の安全性 |

分かったこと(API 仕様):
- 全スレッドが `historyMode: "paginated"`。`thread/read` の `includeTurns` は非推奨で、`thread/turns/list` と `thread/items/list` をページングして読む。カーソルは不透明な JSON 文字列でそのまま返す。
- アイテムは `{turnId, item:{type,id,...}}` の入れ子。種別は userMessage / agentMessage / commandExecution / webSearch / reasoning / fileChange を確認。
- 返却順は `startedAtMs` 昇順とは限らない(`order=mixed`)。API の返却順を使い、時刻で並べ直さない。
- 全スレッドが `notLoaded`。プローブの app-server は Desktop とは別プロセスで、同じスレッドを読めている。
- `readState.revision` が存在する(競合検出に使えるかは P0-05 で確認)。`canAcceptDirectInput` は全スレッドで null。
- cliVersion が 0.155〜0.164 alpha と混在。alpha 版のため API が変わりうる。Adapter でバージョンを記録して変更を検知する。

### 書き込み試験の暫定所見 (2026-10-31)

- 読み取り専用の別プロセスは成立するが、別プロセスからの書き込みは active writer ロックで拒否された。
- 切り分けの案: (A) Desktop 起動中で、対象スレッドを開いていない状態 (B) Desktop 完全終了 (C) Desktop 自身が持つ app-server / remote control 機能への接続(`remoteControl/status/changed` 通知あり。公開仕様は未確認)。
- 非公式な内部データ書き換え(rollout ファイル直接編集など)は行わない(設計書 §10.3)。
- 判定が C の場合は、決定事項 1 に従い読み取り専用 + 引継ぎ資料での新規セッション移行とする。

### 切り分け結果と暫定判定 (2026-10-31)

- 暫定判定: **B(制約付き対応)**。Gateway からの継続は成立するが、Desktop が当該スレッドをロードしている間は書き込めない。
- 条件1(Desktop 起動中で失敗)の原因: 検証スレッドを作った直後で、Desktop がそのスレッドを開いたままだったため(利用者確認)。したがって、Desktop は当該スレッドを開いている間だけ書き込み権を持つ、と見るのが自然。ただし「開いていたスレッドから別スレッドへ切り替えた後に Gateway が書き込めるか」は直接は未検証。
- Adapter 設計への影響: ロック競合を `busy`(再試行可)として扱い、音声で「Codex Desktop が使用中です」と通知する。ロック保持を長時間続けると Desktop 側の利用を妨げる恐れがあるため、必要時のみ resume し、完了後に手放す方針を検討(手放す API は未確認)。
- 書き込み用の指示送信は固定の無害文のみで検証した。実運用の承認ポリシー(コマンド実行等)の挙動は P0-08 で別途確認する。

### 設計方針: スレッド書き込み権の貸し出し (lease)

- Gateway はスレッドを常時保持せず、指示ごとに借りる。app-server 起動 → `thread/resume` → `turn/start` → `turn/completed` まで通知を中継 → プロセス終了で解放。検証では起動から完了まで約3秒。
- ロック競合(`already has an active writer`)は `busy` として扱い、音声で「Codex Desktop が使用中です」と通知する。自動再送はしない。
- 長時間のターン中は Desktop から継続できない(Desktop 側が理由を表示する)。許容できるかは利用評価で判断。
- 確認済み: 解放(プロセス終了)後、Desktop はアプリを閉じずにセッションを切り替えるだけで継続可能に戻る。保持中も履歴は読める。
- 未確認: Codex 側に明示的な解放 API があるか。Desktop 側が、別スレッドへ切り替えた時点で書き込み権を手放すか(直接の試験は未実施)。
