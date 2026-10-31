package dev.vag.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * Gateway への WebSocket 接続。切れたら指数バックオフで再接続し、接続のたびに hello(最後に処理したイベントの位置)を送る。
 * 認証エラー(401)と「別の接続に置き換えられた」(4000)では再接続を繰り返さない。
 */
class GatewayClient(
    private val url: String,
    private val token: String,
    private val positions: PositionStore,
    private val scope: CoroutineScope,
    private val http: OkHttpClient = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build(),
    private val backoff: Backoff = Backoff(),
    private val clientName: String = "android",
) : GatewayLink {
    private val _state = MutableStateFlow(ConnectionState.DISCONNECTED)
    override val state: StateFlow<ConnectionState> = _state

    // 順序を保つため、受信は1本のキューに積む。購読者は1つだけを想定。
    private val channel = Channel<ServerMessage>(Channel.UNLIMITED)
    override val incoming: Flow<ServerMessage> = channel.receiveAsFlow()

    @Volatile private var socket: WebSocket? = null
    private var loop: Job? = null

    private data class Closed(val wsCode: Int?, val httpStatus: Int?)

    override fun start() {
        if (loop?.isActive == true) return
        loop = scope.launch { run() }
    }

    override fun stop() {
        loop?.cancel()
        loop = null
        socket?.close(1000, "client stopping")
        socket = null
        _state.value = ConnectionState.DISCONNECTED
    }

    /** 今の接続を捨てて、つなぎ直す(ネットワークが切り替わったとき等)。 */
    fun reconnectNow() { socket?.cancel() }

    override fun send(msg: ClientMessage): Boolean {
        val ws = socket ?: return false
        return _state.value == ConnectionState.CONNECTED && ws.send(encodeClientMessage(msg))
    }

    private suspend fun run() {
        while (scope.isActive) {
            _state.value = ConnectionState.CONNECTING
            val closed = CompletableDeferred<Closed>()
            val request = Request.Builder().url(url).header("Authorization", "Bearer $token").build()
            val ws = http.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send(encodeClientMessage(Hello(positions.lastEventId, positions.instanceId, clientName)))
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val msg = decodeServerMessage(text) ?: return
                    if (msg is HelloOk) {
                        backoff.reset()
                        _state.value = ConnectionState.CONNECTED
                    }
                    channel.trySend(msg)
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { closed.complete(Closed(code, null)) }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { closed.complete(Closed(null, response?.code)) }
            })
            socket = ws
            val result = try {
                closed.await()
            } finally {
                ws.cancel()
                socket = null
            }
            when {
                result.httpStatus == 401 -> { _state.value = ConnectionState.AUTH_FAILED; return }
                result.wsCode == 4000 -> { _state.value = ConnectionState.REPLACED; return }
            }
            _state.value = ConnectionState.DISCONNECTED
            delay(backoff.nextDelayMs())
        }
    }
}
