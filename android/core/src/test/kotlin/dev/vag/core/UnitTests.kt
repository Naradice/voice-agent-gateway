package dev.vag.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ProtocolTest {
    @Test fun `client messages are encoded the way the gateway expects`() {
        assertEquals("""{"type":"hello","lastEventId":"7","client":"android"}""", encodeClientMessage(Hello(lastEventId = "7", client = "android")))
        assertEquals("""{"type":"hello"}""", encodeClientMessage(Hello()), "null は送らない")
        assertEquals("""{"type":"hello","lastEventId":"7","instanceId":"abc"}""", encodeClientMessage(Hello(lastEventId = "7", instanceId = "abc")))
        assertEquals("""{"type":"ptt.start"}""", encodeClientMessage(PttStart))
        assertEquals("""{"type":"message.send","requestId":"r1","text":"やあ"}""", encodeClientMessage(MessageSend("r1", "やあ")))
        assertEquals("""{"type":"routing.confirm","requestId":"r1","choice":1}""", encodeClientMessage(RoutingConfirm.pick("r1", 1)))
        assertEquals("""{"type":"routing.confirm","requestId":"r1","choice":"cancel"}""", encodeClientMessage(RoutingConfirm.cancel("r1")))
        assertEquals("""{"type":"ack","eventId":"3"}""", encodeClientMessage(Ack("3")))
    }

    @Test fun `server messages are decoded, including optional fields`() {
        val acc = decodeServerMessage("""{"type":"request.accepted","requestId":"r1","destination":"chat","sessionId":"c-3","intent":"send","created":true}""")
        assertEquals(RequestAccepted("r1", "chat", "c-3", "send", true), acc)

        val sp = decodeServerMessage("""{"type":"speech.enqueue","sessionId":"c-3","destination":"chat","priority":"normal","text":"はい。","eventId":"1"}""")
        assertEquals(SpeechEnqueue(eventId = "1", priority = Priority.NORMAL, text = "はい。", sessionId = "c-3", destination = "chat"), sp)

        val eph = decodeServerMessage("""{"type":"speech.enqueue","priority":"normal","text":"起動中","ephemeral":true}""")
        assertIs<SpeechEnqueue>(eph)
        assertNull(eph.eventId)

        val ask = decodeServerMessage("""{"type":"routing.confirmation_required","requestId":"r2","prompt":"どちら","candidates":[{"destination":"codex","sessionId":"x1","label":"A"},{"destination":"chat","label":"B"}]}""")
        assertIs<RoutingConfirmationRequired>(ask)
        assertEquals(listOf("x1", null), ask.candidates.map { it.sessionId })

        val rej = decodeServerMessage("""{"type":"request.rejected","requestId":"r3","code":"busy","message":"使用中","retryable":true}""")
        assertEquals(RequestRejected("r3", "busy", "使用中", true), rej)
    }

    @Test fun `unknown fields, unknown priorities and unknown types do not break the client`() {
        val sp = decodeServerMessage("""{"type":"speech.enqueue","priority":"urgent","text":"x","eventId":"1","newField":123}""")
        assertIs<SpeechEnqueue>(sp)
        assertEquals(Priority.NORMAL, sp.priority)
        assertNull(decodeServerMessage("""{"type":"something.new","a":1}"""))
        assertNull(decodeServerMessage("not json"))
    }
}

class BackoffTest {
    @Test fun `delays double up to the cap and reset after a successful connection`() {
        val b = Backoff(baseMs = 1000, maxMs = 30_000, random = { 0.5 }) // ゆらぎなし(係数 1.0)
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L), List(7) { b.nextDelayMs() })
        b.reset()
        assertEquals(1000L, b.nextDelayMs())
    }

    @Test fun `jitter stays within 20 percent`() {
        assertEquals(800L, Backoff(random = { 0.0 }).nextDelayMs())
        assertEquals(1200L, Backoff(random = { 1.0 }).nextDelayMs())
    }
}

class SpeechQueueTest {
    private fun SpeechQueue.offer(id: Long, p: Priority = Priority.NORMAL, text: String = "t$id") = offerRemote(id, p, text, null)

    @Test fun `critical first, then arrival order within a priority`() {
        val q = SpeechQueue()
        q.offer(1, Priority.NORMAL); q.offer(2, Priority.LOW); q.offer(3, Priority.CRITICAL); q.offer(4, Priority.NORMAL); q.offer(5, Priority.HIGH)
        assertEquals(listOf(3L, 5L, 1L, 4L, 2L), generateSequence { q.poll() }.map { it.eventId }.toList())
    }

    @Test fun `ack position never passes an event that has not been spoken`() {
        val q = SpeechQueue()
        q.offer(1); q.offer(2, Priority.CRITICAL); q.offer(3)
        val first = q.poll()!!          // 2(critical)
        assertEquals(2L, first.eventId)
        assertNull(q.done(first), "1 と 3 が未読なので、2 まで ack してはいけない")
        val second = q.poll()!!         // 1
        assertEquals(2L, q.done(second), "1 と 2 を読み終え、未読は 3 だけ → 2 まで ack できる")
        assertEquals(2L, q.acked)
        val third = q.poll()!!
        assertEquals(3L, q.done(third))
    }

    @Test fun `duplicates from a replay are dropped、spoken ones are reported so they can be re-acked`() {
        val q = SpeechQueue()
        assertEquals(Offer.Accepted, q.offer(1))
        assertEquals(Offer.Duplicate(alreadySpoken = false), q.offer(1))
        val item = q.poll()!!
        assertEquals(Offer.Duplicate(alreadySpoken = false), q.offer(1), "読み上げ中")
        q.offer(2)
        q.done(item) // 1 まで ack は進むが、2 は未読
        assertEquals(Offer.Duplicate(alreadySpoken = true), q.offer(1), "ack 済み")
    }

    @Test fun `a restart resumes from the stored position and ignores what was already acked`() {
        val q = SpeechQueue(initialAcked = 5)
        assertEquals(Offer.Duplicate(alreadySpoken = true), q.offer(5))
        assertEquals(Offer.Accepted, q.offer(6))
        assertEquals(6L, q.done(q.poll()!!))
    }

    @Test fun `resetting for a new gateway instance forgets old positions and unread remote events but keeps local notices`() {
        val q = SpeechQueue(initialAcked = 500)
        q.offer(501); q.offerLocal(Priority.NORMAL, "local")
        q.resetRemote()
        assertNull(q.acked)
        assertEquals(Offer.Accepted, q.offer(1), "番号が 1 から振り直されても重複扱いにならない")
        assertEquals(listOf(null, 1L), generateSequence { q.poll() }.map { it.eventId }.toList())
    }

    @Test fun `local and ephemeral items are never acked and a requeued item keeps its place`() {
        val q = SpeechQueue()
        q.offerLocal(Priority.NORMAL, "local")
        q.offer(1)
        val a = q.poll()!!
        assertNull(a.eventId)
        assertNull(q.done(a))
        val b = q.poll()!!
        q.offer(2)
        q.requeue(b) // 中断されたので戻す
        assertEquals(listOf(1L, 2L), generateSequence { q.poll() }.map { it.eventId }.toList())
    }
}

class ChoiceParserTest {
    private fun pick(text: String, n: Int = 2) = (parseChoice(text, n) as? Choice.Pick)?.index

    @Test fun `numbers in many spoken forms`() {
        for (t in listOf("1番", "一番", "いちばん", "１番です", "1", "最初", "最初のやつ")) assertEquals(0, pick(t), t)
        for (t in listOf("2番", "二番", "にばん", "２番", "二つ目", "ふたつめ", "最後", "2番でお願いします")) assertEquals(1, pick(t), t)
    }

    @Test fun `out of range or ambiguous answers are unknown, not a guess`() {
        for (t in listOf("3番", "どっちでもいい", "えーと", "", "Codexの方")) assertEquals(Choice.Unknown, parseChoice(t, 2), t)
        assertEquals(Choice.Unknown, parseChoice("はい", 2), "候補が複数なら、はい では選べない")
    }

    @Test fun `cancel wins over everything`() {
        for (t in listOf("キャンセル", "やめて", "いいえ", "中止して", "やっぱりいい", "1番やめて")) assertEquals(Choice.Cancel, parseChoice(t, 2), t)
    }

    @Test fun `a single candidate accepts yes`() {
        for (t in listOf("はい", "お願いします", "いいよ", "送って", "OK")) assertEquals(0, pick(t, 1), t)
        assertEquals(Choice.Cancel, parseChoice("いいえ", 1))
    }
}
