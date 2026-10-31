# Android ⇔ Gateway プロトコル (v0.1 draft)

実装: `packages/gateway/src/protocol.ts`(型と検証)、`server.ts`(伝送路)、`gateway.ts`(処理)。設計書 §8 の具体化。
JSON テキストフレームの WebSocket。Android は Agent 固有の情報を持たない(宛先は Gateway が決める)。

## 接続

```
ws://<Gateway の Tailscale IP>:8787
Authorization: Bearer <デバイスのトークン>
```

- トークンはデバイスごとに発行する(24文字以上)。不正なら HTTP 401 で拒否される。トークンは端末の安全な保管領域(Android Keystore 等)に置き、ログに出さない。
- 同じデバイスの新しい接続は、古い接続を **close code 4000** で置き換える。
- **接続後 5 秒以内に `hello` を送る**。送らないと close code 4001。`hello` 前の他のメッセージは `error: not_ready`。
- Gateway は 15 秒ごとに WebSocket の ping を送る。応答がなければ切断する(OkHttp は自動で pong を返す)。端末側も `pingInterval` を設定して、無通信の切断を検知する。
- 1 メッセージは 64KB まで(超えると close code 1009)。`message.send.text` は 2000 文字まで。

## 端末 → Gateway

| type | フィールド | 内容 |
|---|---|---|
| `hello` | `lastEventId?`, `instanceId?`, `client?` | 接続直後に送る。`lastEventId` まで処理済みとして、それより後の未処理イベントを再送する。`instanceId` は最後に `hello.ok` で受け取ったもの(違う Gateway なら `lastEventId` は無視される) |
| `ptt.start` | | PTT が押された。応答なし。モデルの先読みを始める(コールドスタートは数十秒かかることがある) |
| `message.send` | `requestId`, `text`, `sessionId?` | 発話を送る。宛先は Gateway が決める。`sessionId` を指定すると宛先判定を省く |
| `routing.confirm` | `requestId`, `choice` | 確認要求への回答。`choice` は `candidates` の添字(0 始まり)または `"cancel"` |
| `interrupt` | `requestId`, `sessionId?` | 中断。省略時は現在の会話。「止めて」という発話は `message.send` でも中断として扱われる |
| `ack` | `eventId` | その `eventId` まで処理した(読み上げた)。Gateway は保存していたイベントを削除する |

## Gateway → 端末

| type | フィールド | 内容 |
|---|---|---|
| `hello.ok` | `deviceId`, `serverTime`, `replay`, `instanceId` | `replay` 件の未処理イベントがこの直後に届く。**`instanceId` を保存し、前回と違えば `lastEventId` を破棄する**(Gateway の DB を作り直した・別の Gateway につなぎ替えた場合、イベント番号は 1 から振り直されるため。破棄しないと新しいイベントを「読み上げ済み」として捨ててしまう) |
| `request.accepted` | `requestId`, `destination`, `sessionId?`, `intent`, `created?` | 指示を受理した(結果は `speech.enqueue` で届く)。`intent` は `send` / `interrupt` / `read_latest` |
| `request.rejected` | `requestId`, `code`, `message`, `retryable` | 受理できなかった。**`message` は読み上げ可能な日本語**。`retryable` が true なら再試行に意味がある |
| `routing.confirmation_required` | `requestId`, `prompt`, `candidates[]` | 宛先が曖昧、または確認が必要。`prompt` を読み上げ、回答を `routing.confirm` で返す |
| `speech.enqueue` | `eventId?`, `ephemeral?`, `priority`, `text`, `sessionId?`, `destination?` | 読み上げ要求 |
| `error` | `code`, `message` | プロトコル上の誤り(`invalid` / `not_ready` / `internal`)。接続は維持される |

`candidates[]` の各要素: `{ destination, sessionId?, label }`。`label` は「Codexの「JEPA実験」」のように読み上げ可能。`sessionId` がなければ新しい会話。

### `request.rejected` の `code`
`busy`(他のアプリが使用中。パソコン側で閉じる必要)/ `usage_limit`(利用上限)/ `not_found` / `unavailable`(接続できない・ローカルLLM未起動)/ `unsupported` / `protocol` / `ambiguous`(宛先を決められない)/ `cancelled` / `invalid` / **`indeterminate`**(前回の指示が実行されたか不明。自動で再送しない)。

### `speech.enqueue` の扱い
- `priority`: `critical`(エラー・確認の依頼)/ `high`(作業完了)/ `normal`(通常回答)/ `low`(進捗)。**critical は再生中の読み上げに割り込んでよい**。
- チャットの回答は**文単位**で届く。回答の完了を待たずに最初の文から読み始められる。順序は `eventId` 順。
- `eventId` がある → Gateway に保存されている。読み上げたら `ack` を返し、`eventId` を記録する(次回の `hello.lastEventId`)。
- `ephemeral: true`(`eventId` なし)→ 保存されない一時的な通知(例: 「モデルを起動しています」)。**読み上げてよいが、`lastEventId` を更新してはならない**。
- コードブロック・URL・長文は Gateway が整形済み(「コードは省略します」等)。全文は Gateway の履歴に残る。

## プローブ接続(設定画面の接続テスト用)
`ws://host:port/?probe=1` で接続すると、認証(401 になるか)を確かめて `hello.ok` を1つ返し、すぐ閉じる(close code 1000)。**本番の接続を置き換えず**、未配信イベントも再送しない。`hello` は不要。

## 再接続と重複

1. 切断したら、同じ `requestId` を使い回して再接続する。`hello` に最後に処理した `eventId` を入れる。
2. 送信結果が分からない `message.send` は、**同じ `requestId` で再送してよい**。Gateway は二重に実行せず、前回の結果(`request.accepted` / `request.rejected` / 確認要求)を返す。
3. 前回の実行中に Gateway が落ちた場合は `indeterminate` が返る。これは**自動で再実行されない**(外部 Agent に届いたか Gateway では分からないため)。端末は内容を読み上げ、利用者に判断を促す。新しい指示は新しい `requestId` で送る。
4. 未処理イベントの保持期間は 24 時間。`requestId` の記録は 7 日。

## 典型的な流れ

```
端末                                  Gateway
 | ---- (PTT 押下) ptt.start ------->  モデルを先読み
 | ---- message.send r1 "…" ------->  宛先判定
 | <--- request.accepted r1 ---------
 | <--- speech.enqueue {1,"はい。"} --   (文単位)
 | ---- ack 1 ---------------------->
 |
 | ---- message.send r2 "…" ------->  曖昧
 | <--- routing.confirmation_required r2 (prompt, candidates)
 | ---- routing.confirm r2 choice=1 ->
 | <--- request.accepted r2 ---------
```

## 安全上の注意(設計書 §9)
- 高リスク操作(削除・reset・push など)を含む指示は、必ず `routing.confirmation_required` になる。承認を音声だけで完結させる設計にはなっていないので、走行中は確認を後回しにできるよう、端末は `cancel` を常に受け付ける。
- Agent が承認を求めた場合、Gateway は承認せず、`critical` で「パソコンで確認してください」と読み上げる。
