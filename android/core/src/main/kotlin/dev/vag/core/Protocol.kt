package dev.vag.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

// Android ⇔ Gateway のプロトコル。仕様は docs/protocol.md、実装側は packages/gateway/src/protocol.ts。
// 判別用の "type" は kotlinx.serialization の既定の判別子(@SerialName)をそのまま使う。

val ProtocolJson = Json {
    ignoreUnknownKeys = true   // Gateway が項目を足しても壊れない
    coerceInputValues = true   // 未知の priority などは既定値に倒す
    explicitNulls = false      // null の項目は送らない
    encodeDefaults = false
}

@Serializable
enum class Priority {
    @SerialName("critical") CRITICAL,
    @SerialName("high") HIGH,
    @SerialName("normal") NORMAL,
    @SerialName("low") LOW,
}

@Serializable
data class Candidate(val destination: String, val sessionId: String? = null, val label: String)

// ---- 端末 → Gateway ----

@Serializable
sealed interface ClientMessage

@Serializable @SerialName("hello")
data class Hello(val lastEventId: String? = null, val instanceId: String? = null, val client: String? = null) : ClientMessage

@Serializable @SerialName("ptt.start")
data object PttStart : ClientMessage

@Serializable @SerialName("message.send")
data class MessageSend(val requestId: String, val text: String, val sessionId: String? = null) : ClientMessage

@Serializable @SerialName("routing.confirm")
data class RoutingConfirm(val requestId: String, val choice: JsonElement) : ClientMessage {
    companion object {
        fun pick(requestId: String, index: Int) = RoutingConfirm(requestId, JsonPrimitive(index))
        fun cancel(requestId: String) = RoutingConfirm(requestId, JsonPrimitive("cancel"))
    }
}

@Serializable @SerialName("interrupt")
data class Interrupt(val requestId: String, val sessionId: String? = null) : ClientMessage

@Serializable @SerialName("ack")
data class Ack(val eventId: String) : ClientMessage

// ---- Gateway → 端末 ----

@Serializable
sealed interface ServerMessage

@Serializable @SerialName("hello.ok")
data class HelloOk(val deviceId: String, val serverTime: String, val replay: Int, val instanceId: String? = null) : ServerMessage

@Serializable @SerialName("request.accepted")
data class RequestAccepted(
    val requestId: String,
    val destination: String,
    val sessionId: String? = null,
    val intent: String = "send",
    val created: Boolean? = null,
) : ServerMessage

@Serializable @SerialName("request.rejected")
data class RequestRejected(val requestId: String, val code: String, val message: String, val retryable: Boolean = false) : ServerMessage

@Serializable @SerialName("routing.confirmation_required")
data class RoutingConfirmationRequired(val requestId: String, val prompt: String, val candidates: List<Candidate>) : ServerMessage

/** eventId があれば Gateway に保存されており ack が必要。ephemeral(eventId なし)は保存されない一時的な通知。 */
@Serializable @SerialName("speech.enqueue")
data class SpeechEnqueue(
    val eventId: String? = null,
    val ephemeral: Boolean? = null,
    val priority: Priority = Priority.NORMAL,
    val text: String,
    val sessionId: String? = null,
    val destination: String? = null,
) : ServerMessage

@Serializable @SerialName("error")
data class ErrorMessage(val code: String, val message: String) : ServerMessage

fun encodeClientMessage(msg: ClientMessage): String = ProtocolJson.encodeToString<ClientMessage>(msg)

/** 未知の type や壊れた JSON は null(将来 Gateway が新しいメッセージを足しても、古い端末が落ちないように)。 */
fun decodeServerMessage(text: String): ServerMessage? =
    try { ProtocolJson.decodeFromString<ServerMessage>(text) } catch (_: SerializationException) { null } catch (_: IllegalArgumentException) { null }
