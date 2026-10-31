package dev.vag.core

import java.util.TreeSet

/** 読み上げの1単位。eventId が null のもの(一時的な通知・端末内のメッセージ)は ack の対象ではない。 */
class SpeechItem(val eventId: Long?, val priority: Priority, val text: String, val sessionId: String?, internal val seq: Long)

sealed interface Offer {
    data object Accepted : Offer
    /** すでに受け取っている。alreadySpoken なら読み上げ済み(ack が届いていなかった)。 */
    data class Duplicate(val alreadySpoken: Boolean) : Offer
}

/**
 * 優先度付きの読み上げキューと、ack の位置(watermark)の管理。スレッドセーフではない(呼び出し側が単一スレッドに閉じる)。
 *
 * ack の位置の規則: 「受け取ったイベントのうち、すべて読み終えた最大の位置」。Gateway の ack は「その位置まで削除」なので、
 * 優先度で順序が入れ替わっても、読んでいないイベントを巻き込んで削除させない。
 * 同じ接続の中ではイベントが昇順に届くので、後から小さい eventId が届くことはない(再接続時の再送は重複として捨てる)。
 */
class SpeechQueue(initialAcked: Long? = null) {
    private val order = Comparator<SpeechItem> { a, b ->
        val p = a.priority.ordinal.compareTo(b.priority.ordinal) // CRITICAL が先頭
        if (p != 0) p else a.seq.compareTo(b.seq)
    }
    private val waiting = TreeSet(order)
    private val unfinished = TreeSet<Long>() // 受け取ったが読み終えていないイベント(読み上げ中を含む)
    private val finished = HashSet<Long>()   // 読み終えたが ack がまだの位置
    private var maxSeen: Long = initialAcked ?: 0
    private var counter = 0L

    /** 最後に確定した ack の位置。 */
    var acked: Long? = initialAcked
        private set

    fun offerRemote(eventId: Long, priority: Priority, text: String, sessionId: String?): Offer {
        if ((acked != null && eventId <= acked!!) || eventId in finished) return Offer.Duplicate(alreadySpoken = true)
        if (eventId in unfinished) return Offer.Duplicate(alreadySpoken = false)
        unfinished.add(eventId)
        maxSeen = maxOf(maxSeen, eventId)
        waiting.add(SpeechItem(eventId, priority, text, sessionId, counter++))
        return Offer.Accepted
    }

    /** 保存されないメッセージ(一時的な通知、端末内で作る案内)。 */
    fun offerLocal(priority: Priority, text: String, sessionId: String? = null) {
        waiting.add(SpeechItem(null, priority, text, sessionId, counter++))
    }

    fun poll(): SpeechItem? = waiting.pollFirst()

    fun peekPriority(): Priority? = waiting.firstOrNull()?.priority

    /** 読み上げを中断したとき、元の順序の位置に戻す(読み上げ済みにはしない)。 */
    fun requeue(item: SpeechItem) { waiting.add(item) }

    val size: Int get() = waiting.size

    /** 読み終えた(または聞き手が飛ばした)。ack の位置が進んだらその位置を返す。 */
    fun done(item: SpeechItem): Long? {
        val id = item.eventId ?: return null
        unfinished.remove(id)
        finished.add(id)
        val candidate = if (unfinished.isEmpty()) maxSeen else unfinished.first() - 1
        val current = acked ?: 0
        if (candidate <= current) return null
        acked = candidate
        finished.removeAll { it <= candidate }
        return candidate
    }
}
