package dev.vag.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** 偽の接続・音声認識・読み上げで、VoiceController の振る舞い(読み上げの順序、割り込み、ack、再送)を確かめる。 */
class VoiceControllerTest {
    private class Rig(responseTimeoutMs: Long = 20_000, storedPosition: String? = null) {
        val link = FakeLink()
        val rec = FakeRecognizer()
        val tts = FakeTts()
        val positions = InMemoryPositionStore(storedPosition)
        val scope = singleThreadScope()
        private val ids = AtomicInteger()
        val controller = VoiceController(link, rec, tts, positions, scope, { "req-${ids.incrementAndGet()}" }, responseTimeoutMs)

        fun connect() {
            controller.start()
            link.state.value = ConnectionState.CONNECTED
            eventually(message = "IDLE") { controller.state.value == VoiceState.IDLE }
        }
        fun acks() = link.sentOf<Ack>().map { it.eventId }
        fun close() { controller.stop(); scope.cancel() }
    }

    private val rigs = mutableListOf<Rig>()
    private fun rig(timeout: Long = 20_000, stored: String? = null) = Rig(timeout, stored).also { rigs += it }
    @AfterTest fun cleanup() { rigs.forEach { it.close() }; rigs.clear() }

    @Test fun `nothing is spoken while listening, then critical first and the ack position never skips an unspoken event`() {
        val r = rig()
        r.connect()
        r.rec.gate = CompletableDeferred()
        r.rec.results.add(null) // 聞き取れなかった
        r.controller.onPttPressed()
        eventually(message = "LISTENING") { r.controller.state.value == VoiceState.LISTENING }
        assertTrue(r.link.sent.any { it is PttStart }, "PTT で先読みを依頼する")

        r.link.speech(1, "a"); r.link.speech(2, "b", Priority.CRITICAL); r.link.speech(3, "c")
        runBlocking { delay(200) }
        assertTrue(r.tts.started.isEmpty(), "聞いている間は話さない(音声がマイクに回り込むため)")

        r.rec.gate!!.complete(Unit)
        eventually(message = "4 spoken") { r.tts.spoken.size == 4 }
        assertEquals(listOf("b", "a", "c", "聞き取れませんでした。もう一度お願いします。"), r.tts.spoken.toList())
        assertEquals(listOf("2", "3"), r.acks(), "b(2)を先に読んでも、a(1)が未読の間は ack しない")
        assertEquals("3", r.positions.lastEventId)
    }

    @Test fun `pressing PTT while speaking stops the speech, counts it as done, and starts listening`() {
        val r = rig()
        r.connect()
        r.tts.hold = CompletableDeferred()
        r.link.speech(1, "長い説明")
        eventually(message = "SPEAKING") { r.controller.state.value == VoiceState.SPEAKING }
        r.rec.results.add("やあ")
        r.controller.onPttPressed()
        eventually(message = "message sent") { r.link.sentOf<MessageSend>().isNotEmpty() }
        assertEquals("やあ", r.link.sentOf<MessageSend>().single().text)
        assertTrue(r.tts.stops >= 1)
        assertFalse("長い説明" in r.tts.spoken)
        assertEquals("1", r.positions.lastEventId, "飛ばした分は読み終えた扱い(再送されて読み直さない)")
    }

    @Test fun `a critical message interrupts normal speech, which is read again afterwards`() {
        val r = rig()
        r.connect()
        r.tts.hold = CompletableDeferred()
        r.link.speech(1, "通常")
        eventually(message = "SPEAKING") { r.controller.state.value == VoiceState.SPEAKING }
        r.link.speech(2, "重要", Priority.CRITICAL)
        eventually(message = "critical started") { "重要" in r.tts.started }
        r.tts.hold!!.complete(Unit)
        eventually(message = "both spoken") { r.tts.spoken.size == 2 }
        assertEquals(listOf("通常", "重要", "通常"), r.tts.started.toList())
        assertEquals(listOf("重要", "通常"), r.tts.spoken.toList())
        assertEquals("2", r.positions.lastEventId)
    }

    @Test fun `an unanswered request is sent again with the same id after reconnecting`() {
        val r = rig()
        r.connect()
        r.rec.results.add("こんにちは")
        r.controller.onPttPressed()
        eventually(message = "first send") { r.link.sentOf<MessageSend>().size == 1 }
        val id = r.link.sentOf<MessageSend>().single().requestId

        r.link.state.value = ConnectionState.DISCONNECTED
        runBlocking { delay(100) }
        r.link.state.value = ConnectionState.CONNECTED
        eventually(message = "resend") { r.link.sentOf<MessageSend>().size == 2 }
        assertEquals(listOf(id, id), r.link.sentOf<MessageSend>().map { it.requestId })

        r.link.deliver(RequestAccepted(id, "chat"))
        eventually(message = "IDLE") { r.controller.state.value == VoiceState.IDLE }
        r.link.state.value = ConnectionState.DISCONNECTED
        runBlocking { delay(100) }
        r.link.state.value = ConnectionState.CONNECTED
        runBlocking { delay(150) }
        assertEquals(2, r.link.sentOf<MessageSend>().size, "受理済みの要求は送り直さない")
    }

    @Test fun `a confirmation request is read aloud and the next PTT answer picks a candidate`() {
        val r = rig()
        r.connect()
        r.link.deliver(RoutingConfirmationRequired("r1", "どちらですか。1番、Codex。2番、チャット。", listOf(Candidate("codex", "x1", "Codex"), Candidate("chat", "c1", "チャット"))))
        eventually(message = "prompt spoken") { "どちらですか。1番、Codex。2番、チャット。" in r.tts.spoken }
        r.rec.results.add("2番")
        r.controller.onPttPressed()
        eventually(message = "confirm sent") { r.link.sentOf<RoutingConfirm>().isNotEmpty() }
        assertEquals(RoutingConfirm.pick("r1", 1), r.link.sentOf<RoutingConfirm>().single())
    }

    @Test fun `three unintelligible answers cancel the confirmation instead of guessing`() {
        val r = rig()
        r.connect()
        r.link.deliver(RoutingConfirmationRequired("r1", "どちらですか", listOf(Candidate("codex", "x1", "A"), Candidate("chat", "c1", "B"))))
        eventually(message = "prompt") { "どちらですか" in r.tts.spoken }
        repeat(3) { i ->
            r.rec.results.add("えーと")
            r.controller.onPttPressed()
            eventually(message = "answer $i handled") { r.controller.state.value == VoiceState.IDLE && r.rec.results.isEmpty() && !r.rec.listening }
            runBlocking { delay(30) }
        }
        eventually(message = "cancel sent") { r.link.sentOf<RoutingConfirm>().isNotEmpty() }
        assertEquals(RoutingConfirm.cancel("r1"), r.link.sentOf<RoutingConfirm>().single())
        eventually(message = "spoken") { "分からなかったので、キャンセルしました。" in r.tts.spoken }
    }

    @Test fun `a rejection is read aloud urgently and the controller returns to idle`() {
        val r = rig()
        r.connect()
        r.rec.results.add("続けて")
        r.controller.onPttPressed()
        eventually(message = "send") { r.link.sentOf<MessageSend>().isNotEmpty() }
        r.link.deliver(RequestRejected(r.link.sentOf<MessageSend>().single().requestId, "busy", "別のアプリで使用中です。", true))
        eventually(message = "spoken") { "別のアプリで使用中です。" in r.tts.spoken }
        eventually(message = "IDLE") { r.controller.state.value == VoiceState.IDLE }
    }

    @Test fun `an event replayed after reconnecting is not read twice, but is acknowledged again`() {
        val r = rig()
        r.connect()
        r.link.speech(1, "a")
        eventually(message = "spoken") { r.tts.spoken.size == 1 }
        eventually(message = "acked") { r.acks() == listOf("1") }
        r.link.speech(1, "a") // ack が届かなかった場合の再送
        eventually(message = "re-ack") { r.acks().size == 2 }
        runBlocking { delay(100) }
        assertEquals(listOf("a"), r.tts.spoken.toList())
        assertEquals(listOf("1", "1"), r.acks())
    }

    @Test fun `ephemeral notices are read but never acknowledged`() {
        val r = rig()
        r.connect()
        r.link.speech(null, "モデルを起動しています")
        eventually(message = "spoken") { "モデルを起動しています" in r.tts.spoken }
        runBlocking { delay(100) }
        assertTrue(r.acks().isEmpty())
        assertEquals(null, r.positions.lastEventId)
    }

    @Test fun `a restart resumes from the stored position`() {
        val r = rig(stored = "5")
        r.connect()
        r.link.speech(5, "既読"); r.link.speech(6, "新着")
        eventually(message = "spoken") { "新着" in r.tts.spoken }
        assertFalse("既読" in r.tts.started)
        eventually(message = "ack") { r.positions.lastEventId == "6" }
    }

    @Test fun `no response within the timeout returns to idle with a spoken notice`() {
        val r = rig(timeout = 150)
        r.connect()
        r.rec.results.add("こんにちは")
        r.controller.onPttPressed()
        eventually(message = "timeout notice") { "応答がありません。しばらくしてからお試しください。" in r.tts.spoken }
        eventually(message = "IDLE") { r.controller.state.value == VoiceState.IDLE }
    }

    @Test fun `pressing PTT while disconnected says so instead of listening`() {
        val r = rig()
        r.controller.start()
        r.controller.onPttPressed()
        eventually(message = "notice") { "Gatewayに接続されていません。" in r.tts.spoken }
        assertFalse(r.rec.listening)
    }

    @Test fun `pressing PTT again while listening ends the input early`() {
        val r = rig()
        r.connect()
        r.rec.gate = CompletableDeferred()
        r.rec.results.add("やあ")
        r.controller.onPttPressed()
        eventually(message = "LISTENING") { r.controller.state.value == VoiceState.LISTENING }
        r.controller.onPttPressed()
        eventually(message = "send") { r.link.sentOf<MessageSend>().isNotEmpty() }
        assertEquals(1, r.rec.finishCalls)
    }

    @Test fun `an authentication failure is announced`() {
        val r = rig()
        r.controller.start()
        r.link.state.value = ConnectionState.AUTH_FAILED
        eventually(message = "notice") { r.tts.spoken.any { it.contains("認証に失敗しました") } }
    }
}
