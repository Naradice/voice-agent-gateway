# Android クライアント

`android/` に Gradle プロジェクトがある。プロトコルは `docs/protocol.md`。

| モジュール | 内容 | 検証状況 |
|---|---|---|
| `android/core` | Android に依存しない Kotlin/JVM。プロトコル型、再接続する WebSocket クライアント、読み上げキューと ack 位置の管理、確認への回答の解釈、PTT から読み上げまでを統括する `VoiceController` | **ビルドとテスト済み(39件)**。うち7件は、本物の Gateway(`packages/gateway/src/mock.ts`)を子プロセスで起動して接続する結合テスト |
| `android/app` | 画面(Compose)、フォアグラウンドサービス、`SpeechRecognizer`、`TextToSpeech`、設定の保存。`core` を呼ぶだけの薄い層 | **未ビルド・未実行。** 開発環境から Android SDK(Google の Maven)に届かず、一度もコンパイルしていない |

## core のテスト
```bash
cd android && ./gradlew :core:test      # Node が PATH にあること(結合テストが Gateway のモックを起動する)
```
Android SDK が無い環境では `:app` は自動的に除外される(`settings.gradle.kts`)。

## アプリのビルド・実行
1. Android Studio で `android/` を開く(JDK 17 以上)。`local.properties` が作られると `:app` が含まれる。
2. 実機で実行(`minSdk 26`)。初回に、マイクと通知の許可を求められる。
3. 動作確認には、PC で Android 開発用のモック Gateway を使う(Ollama・Codex 不要):
   ```bash
   npm run gateway:init      # 初回。.env とトークンを作る(VAG_HOST に PC の Tailscale IP が入る)
   npm run gateway:mock
   ```
4. アプリの「設定」に `ws://<PCのTailscale IP>:8787` とトークンを入力する。エミュレータなら `ws://10.0.2.2:8787`(VAG_HOST を `0.0.0.0` にはせず、エミュレータ用に別途設定する必要がある点に注意)。
5. 試せる発話(モックの台本): 「こんにちは」(文単位の読み上げ)/「JEPAの実験の件」(確認 → 「1番」と答える)/「busyの確認をCodexで」(使用中の案内)/「Codexの返事を読んで」。

## 設計上の判断
- **core と app を分けた。** 読み上げの順序・割り込み・ack・再送など、間違えるとデータを失うロジックを、Android なしでテストできるようにするため。app は音声認識・合成・画面の接続だけ。
- **PTT は「タップで開始、もう一度で確定」。** 音声認識は無音検出でも終わる。読み上げ中にタップすると、読み上げを止めて聞く(割り込み。止めた1文は読み終えた扱い)。
- **マイクは PTT のときだけ使う。** 確認要求への回答も、あらためて PTT で受ける(自動で聞き始めない)。聞いている間は読み上げない(音声がマイクに回り込むため)。
- **ack は「読み終えた最大の位置」。** 優先度で順序が入れ替わっても、未読のイベントを巻き込んで Gateway に削除させない。
- **ack の位置は Gateway の識別子(`instanceId`)とセットで保存する。** DB の作り直しや別の Gateway への切り替えで番号が振り直されても、新しいイベントを「読み上げ済み」として捨てない(回帰テストあり)。
- **設定は SharedPreferences。** 設計書の DataStore ではなく同期的に読み書きできる方を選んだ(位置の保存が読み上げのたびに呼ばれるため)。トークンは Android Keystore の鍵で暗号化して保存する。
- **`ws://` を許可している。** Tailscale(WireGuard)で暗号化される前提。公開ネットワークで使うなら `wss://` にして `network_security_config.xml` を厳しくする。

## 実機で確認が必要なこと(未確認)
- `android/app` が初回のビルドで通るか。Compose BOM・AGP のバージョンは、環境で解決できる最新に合わせて調整が要るかもしれない。
- `SpeechRecognizer` の日本語認識の品質、オフライン認識の可否、端末ごとの差(設計書 §13: STT は実機評価)。
- 画面ロック中・Doze 中の動作。フォアグラウンドサービス(マイク種別)の開始条件(Android 14 以降は画面が見えている状態で開始する必要がある)。
- `TextToSpeech` の日本語音声、イヤホン接続時の挙動、他アプリの音声との競合(オーディオフォーカスは未実装)。
- バッテリー最適化による切断、再接続の挙動、モバイル回線と Wi-Fi の切り替え。

## 未実装
- Bluetooth イヤホンの PTT(Phase 4)。ネットワーク切り替えの検知(`GatewayClient.reconnectNow()` はある)。
- 読み上げ待ちの一覧表示、履歴の表示、エラーの通知(読み上げのみ)。
- 割り込み時に、同じ会話の残りの読み上げを捨てるか(現状は残りも読む)。
- 認証トークンの発行・失効の仕組み(現状は手動)。
