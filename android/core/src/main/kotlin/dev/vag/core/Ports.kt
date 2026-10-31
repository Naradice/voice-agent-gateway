package dev.vag.core

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/** 音声認識(Android では SpeechRecognizer)。認識の実装は端末側に置き、ロジックは core に閉じる。 */
interface SpeechRecognizerPort {
    /** 認識結果を返す。聞き取れなかった場合は null。話し終えたと判断した時点で onEndOfSpeech を呼ぶ。キャンセルされたら中断する。 */
    suspend fun listen(onEndOfSpeech: () -> Unit): String?
    /** 無音検出を待たず、ここまでの入力で確定する。 */
    fun finish()
    fun cancel()
}

/** 音声合成(Android では TextToSpeech)。 */
interface TtsPort {
    /** 読み終えるまで中断する。コルーチンがキャンセルされたら読み上げを止める。 */
    suspend fun speak(text: String)
    fun stop()
}

/** 最後に処理した(ack した)イベントの位置。再起動をまたいで残す(Android では DataStore)。 */
interface PositionStore {
    var lastEventId: String?
}

class InMemoryPositionStore(override var lastEventId: String? = null) : PositionStore

enum class ConnectionState { DISCONNECTED, CONNECTING, CONNECTED, AUTH_FAILED, REPLACED }

/** Gateway との接続。実装は GatewayClient。テストでは偽物に差し替える。 */
interface GatewayLink {
    val state: StateFlow<ConnectionState>
    /** 単一の購読者を想定。接続が切れ直しても同じ Flow から読み続けられる。 */
    val incoming: Flow<ServerMessage>
    fun start()
    fun stop()
    fun send(msg: ClientMessage): Boolean
}
