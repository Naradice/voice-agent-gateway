package dev.vag.core

import kotlin.math.min

/** 再接続の待ち時間: 1秒から倍々に増やし、上限 30 秒。±20% のゆらぎで、複数端末の再接続が重ならないようにする。 */
class Backoff(
    private val baseMs: Long = 1_000,
    private val maxMs: Long = 30_000,
    private val random: () -> Double = { Math.random() },
) {
    private var attempt = 0

    fun nextDelayMs(): Long {
        val exp = min(maxMs, baseMs shl min(attempt, 10))
        attempt++
        return (exp * (0.8 + 0.4 * random())).toLong()
    }

    fun reset() { attempt = 0 }
}
