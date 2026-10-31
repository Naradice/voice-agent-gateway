package dev.vag.app

import android.content.Context
import dev.vag.core.ConnectionState
import dev.vag.core.GatewayClient
import dev.vag.core.VoiceController
import dev.vag.core.VoiceState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * アプリ全体で1つの VoiceController を保持する。画面(Activity)が閉じても、フォアグラウンドサービスが生きている間は動き続ける。
 * メインスレッドから呼ぶこと(コントローラはメインスレッドの単一スコープで動く)。
 */
object VoiceRuntime {
    private var scope: CoroutineScope? = null
    private var tts: AndroidTts? = null

    private val _controller = MutableStateFlow<VoiceController?>(null)
    val controller: StateFlow<VoiceController?> = _controller

    private val _connection = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connection: StateFlow<ConnectionState> = _connection

    private val _status = MutableStateFlow("未接続")
    /** 通知に出す短い状態表示。 */
    val status: StateFlow<String> = _status

    fun start(context: Context) {
        if (_controller.value != null) return
        val settings = Settings(context)
        if (!settings.isConfigured) return
        val app = context.applicationContext

        val s = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        scope = s
        val client = GatewayClient(settings.url!!, settings.token!!, settings.positions, s)
        val speaker = AndroidTts(app)
        tts = speaker
        val controller = VoiceController(client, AndroidSpeechRecognizer(app), speaker, settings.positions, s)

        s.launch { client.state.collect { _connection.value = it } }
        s.launch { combine(client.state, controller.state) { c, v -> statusText(c, v) }.collect { _status.value = it } }
        controller.start()
        _controller.value = controller
    }

    fun stop() {
        _controller.value?.stop()
        tts?.shutdown()
        scope?.cancel()
        tts = null
        scope = null
        _controller.value = null
        _connection.value = ConnectionState.DISCONNECTED
        _status.value = "停止中"
    }

    fun restart(context: Context) {
        stop()
        start(context)
    }

    fun pressPtt() { _controller.value?.onPttPressed() }

    fun statusText(c: ConnectionState, v: VoiceState): String = when (c) {
        ConnectionState.AUTH_FAILED -> "認証に失敗しました(設定を確認)"
        ConnectionState.REPLACED -> "別の端末に接続を置き換えられました"
        ConnectionState.CONNECTING -> "接続中…"
        ConnectionState.DISCONNECTED -> "未接続(再接続を試行中)"
        ConnectionState.CONNECTED -> when (v) {
            VoiceState.LISTENING -> "聞いています"
            VoiceState.TRANSCRIBING -> "認識中"
            VoiceState.SENDING -> "送信中"
            VoiceState.SPEAKING -> "読み上げ中"
            else -> "待機中"
        }
    }
}
