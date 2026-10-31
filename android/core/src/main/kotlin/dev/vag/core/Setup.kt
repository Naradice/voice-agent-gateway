package dev.vag.core

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.security.MessageDigest
import kotlin.coroutines.resume

/**
 * トークンの確認コード(SHA-256 の先頭6桁の16進)。入力ミスの確認用で、トークン本体は画面に出さない。
 * Gateway 側の `npm run gateway:code` と同じ値になる(24ビットなので、トークンの手がかりにはならない)。
 */
fun tokenFingerprint(token: String): String =
    MessageDigest.getInstance("SHA-256").digest(token.trim().toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }.take(6)

data class ConnectionCode(val url: String, val token: String)

/** `ws://host:port#token` の形の接続コードを解析する。壊れた・短すぎるものは null(誤って部分的に設定しない)。 */
fun parseConnectionCode(raw: String): ConnectionCode? {
    val line = raw.trim().lineSequence().firstOrNull()?.trim() ?: return null
    val i = line.lastIndexOf('#')
    if (i <= 0) return null
    val url = line.substring(0, i).trim()
    val token = line.substring(i + 1).trim()
    if (!(url.startsWith("ws://") || url.startsWith("wss://")) || url.length < 8) return null
    if (token.length < 16 || token.any { it.isWhitespace() }) return null
    return ConnectionCode(url, token)
}

sealed interface ConnectionTestResult {
    data class Ok(val deviceId: String, val instanceId: String?) : ConnectionTestResult
    /** Gateway には届いたが、トークンが違う。 */
    data object AuthFailed : ConnectionTestResult
    data class Failed(val reason: String) : ConnectionTestResult
}

/**
 * 設定を保存する前の「接続テスト」。プローブ接続(?probe=1)を使うので、動いている本番の接続を追い出さない。
 * 届くか・トークンが合っているか・Gateway が応答するかを、タイムアウトつきで確かめる。
 */
suspend fun testConnection(
    url: String,
    token: String,
    timeoutMs: Long = 8_000,
    http: OkHttpClient = OkHttpClient(),
): ConnectionTestResult {
    val probeUrl = url + (if ('?' in url) "&" else "?") + "probe=1"
    val request = try {
        Request.Builder().url(probeUrl).header("Authorization", "Bearer ${token.trim()}").build()
    } catch (_: IllegalArgumentException) {
        return ConnectionTestResult.Failed("接続先の形式が正しくありません(例: ws://100.x.x.x:8787)")
    }
    return withTimeoutOrNull(timeoutMs) {
        suspendCancellableCoroutine<ConnectionTestResult> { cont ->
            fun finish(r: ConnectionTestResult) { if (cont.isActive) cont.resume(r) }
            val ws = http.newWebSocket(request, object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val m = decodeServerMessage(text)
                    if (m is HelloOk) finish(ConnectionTestResult.Ok(m.deviceId, m.instanceId))
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    finish(ConnectionTestResult.Failed("応答の前に切断されました"))
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    finish(
                        when (response?.code) {
                            401 -> ConnectionTestResult.AuthFailed
                            null -> ConnectionTestResult.Failed(t.message ?: t.javaClass.simpleName)
                            else -> ConnectionTestResult.Failed("HTTP ${response.code}")
                        },
                    )
                }
            })
            cont.invokeOnCancellation { ws.cancel() }
        }
    } ?: ConnectionTestResult.Failed("応答がありません(タイムアウト)。接続先・Tailscale・ファイアウォールを確認してください")
}
