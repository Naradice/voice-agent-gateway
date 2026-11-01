package dev.vag.app

import android.content.Context
import dev.vag.core.ConnectionState
import dev.vag.core.GatewayClient
import dev.vag.core.Notices
import dev.vag.core.VoiceController
import dev.vag.core.VoiceState
import dev.vag.core.tokenFingerprint
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

    private val _lastError = MutableStateFlow<String?>(null)
    /** 直近の接続失敗の理由(画面表示用)。 */
    val lastError: StateFlow<String?> = _lastError

    private val _activeFingerprint = MutableStateFlow<String?>(null)
    /** いま接続に使っているトークンの確認コード(保存された値ではなく、実際に動いている接続のもの)。 */
    val activeFingerprint: StateFlow<String?> = _activeFingerprint

    private val _voiceState = MutableStateFlow(VoiceState.DISCONNECTED)
    /** 音声の状態(聞き始めのビープ音など、画面を見ない合図に使う)。 */
    val voiceState: StateFlow<VoiceState> = _voiceState

    private val _earphoneButton = MutableStateFlow(true)
    /** イヤホンのボタンで話す、の設定。 */
    val earphoneButton: StateFlow<Boolean> = _earphoneButton

    private val _volumeDownPtt = MutableStateFlow(false)
    /** 音量下キーで話す、の設定。 */
    val volumeDownPtt: StateFlow<Boolean> = _volumeDownPtt

    fun syncSettings(context: Context) {
        val s = Settings(context)
        _earphoneButton.value = s.earphoneButton
        _volumeDownPtt.value = s.volumeDownPtt
    }

    fun setVolumeDownPtt(context: Context, enabled: Boolean) {
        Settings(context).volumeDownPtt = enabled
        _volumeDownPtt.value = enabled
    }

    fun setEarphoneButton(context: Context, enabled: Boolean) {
        Settings(context).earphoneButton = enabled
        _earphoneButton.value = enabled
    }

    private val _notices = MutableStateFlow(Notices(0))
    /** 待機メッセージの未読件数(通知に出す)。 */
    val notices: StateFlow<Notices> = _notices

    private val _status = MutableStateFlow("未接続")
    /** 通知に出す短い状態表示。 */
    val status: StateFlow<String> = _status

    fun start(context: Context) {
        if (_controller.value != null) return
        val settings = Settings(context)
        if (!settings.isConfigured) return
        val url = settings.url
        val token = settings.token
        if (url.isNullOrBlank() || token == null) {
            // 端末の鍵が変わった等で、保存したトークンを読み出せない。
            _lastError.value = "保存されたトークンを読み出せません。設定でトークンを入力し直してください"
            return
        }
        _lastError.value = null
        _activeFingerprint.value = tokenFingerprint(token)
        val app = context.applicationContext

        val s = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        scope = s
        val client = GatewayClient(url, token, settings.positions, s)
        val speaker = AndroidTts(app)
        tts = speaker
        val controller = VoiceController(client, AndroidSpeechRecognizer(app), speaker, settings.positions, s)

        s.launch { client.state.collect { _connection.value = it } }
        s.launch { client.lastError.collect { _lastError.value = it } }
        s.launch { combine(client.state, controller.state) { c, v -> statusText(c, v) }.collect { _status.value = it } }
        s.launch { controller.state.collect { _voiceState.value = it } }
        s.launch { controller.notices.collect { _notices.value = it } }
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
        _activeFingerprint.value = null
        _notices.value = Notices(0)
        _voiceState.value = VoiceState.DISCONNECTED
        _connection.value = ConnectionState.DISCONNECTED
        _status.value = "停止中"
    }

    fun restart(context: Context) {
        stop()
        start(context)
    }

    fun pressPtt() { _controller.value?.onPttPressed() }

    /** 待機メッセージを読み上げさせる(通知の「読む」ボタン)。 */
    fun readNotices() { _controller.value?.readNotices() }

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
