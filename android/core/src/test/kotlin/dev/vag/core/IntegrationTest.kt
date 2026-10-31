package dev.vag.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private const val TOKEN = "integration-token-0123456789abcdef"

/** 本物の Gateway(packages/gateway/src/mock.ts)を子プロセスとして起動する。Node が無い環境ではテストを飛ばす。 */
class MockGateway : AutoCloseable {
    val port: Int = ServerSocket(0).use { it.localPort }
    val url get() = "ws://127.0.0.1:$port"
    private val process: Process

    init {
        val repo = File(System.getProperty("vag.repo") ?: ".")
        assumeTrue(File(repo, "packages/gateway/src/mock.ts").exists(), "リポジトリのルートが見つからない")
        assumeTrue(runCatching { ProcessBuilder("node", "--version").redirectErrorStream(true).start().waitFor() == 0 }.getOrDefault(false), "node が無い")
        val pb = ProcessBuilder("node", "--experimental-strip-types", "--no-warnings", "packages/gateway/src/mock.ts")
            .directory(repo).redirectErrorStream(true)
        pb.environment().apply {
            put("VAG_DEVICES", """[{"deviceId":"pixel","token":"$TOKEN"}]""")
            put("VAG_HOST", "127.0.0.1")
            put("VAG_PORT", port.toString())
            put("VAG_ENV_FILE", "/nonexistent/.env") // 開発者の .env を読まない
            remove("VAG_DB")
        }
        process = pb.start()
        val ready = CountDownLatch(1)
        thread(isDaemon = true) { process.inputStream.bufferedReader().forEachLine { if ("gateway started" in it) ready.countDown() } }
        if (!ready.await(30, TimeUnit.SECONDS)) { process.destroyForcibly(); error("モック Gateway が起動しなかった") }
    }

    override fun close() { process.destroy(); process.waitFor(5, TimeUnit.SECONDS) }
}

class IntegrationTest {
    // storedPosition / storedInstance は、アプリを起動する前に保存されていた状態(コントローラは作成時にこれを読む)
    private class Rig(token: String = TOKEN, storedPosition: String? = null, storedInstance: String? = null) : AutoCloseable {
        val gateway = MockGateway()
        val positions = InMemoryPositionStore(storedPosition, storedInstance)
        val scope = singleThreadScope()
        val client = GatewayClient(gateway.url, token, positions, scope, backoff = Backoff(baseMs = 200, maxMs = 400))
        val rec = FakeRecognizer()
        val tts = FakeTts()
        val controller = VoiceController(client, rec, tts, positions, scope)
        val states = CopyOnWriteArrayList<ConnectionState>()

        init { scope.launch { client.state.collect { states.add(it) } } }

        fun start() {
            controller.start()
            eventually(15_000, "IDLE") { controller.state.value == VoiceState.IDLE }
        }
        fun say(text: String) {
            rec.results.add(text)
            controller.onPttPressed()
        }
        fun idle() = eventually(message = "back to IDLE") { controller.state.value == VoiceState.IDLE }
        override fun close() { controller.stop(); scope.cancel(); gateway.close() }
    }

    private val rigs = mutableListOf<AutoCloseable>()
    private fun rig(token: String = TOKEN, stored: String? = null, instance: String? = null) = Rig(token, stored, instance).also { rigs += it }
    @AfterTest fun cleanup() { rigs.forEach { it.close() }; rigs.clear() }

    @Test fun `a spoken request streams back sentence by sentence and is acknowledged`() {
        val r = rig(); r.start()
        r.say("こんにちは")
        eventually(message = "3 sentences") { r.tts.spoken.size == 3 }
        assertEquals(listOf("「こんにちは」ですね。", "これはモックの応答です。", "実際のモデルは動いていません。"), r.tts.spoken.toList())
        eventually(message = "ack position") { r.positions.lastEventId == "3" }
        r.idle()
    }

    @Test fun `a stale position from a previous gateway does not swallow the new gateways events`() {
        val r = rig(stored = "500", instance = "previous-gateway") // 以前つないでいた Gateway の位置
        r.start()
        r.say("こんにちは")
        eventually(message = "3 sentences") { r.tts.spoken.size == 3 }
        eventually(message = "position follows the new gateway") { r.positions.lastEventId == "3" }
        assertTrue(r.positions.instanceId != "previous-gateway" && r.positions.instanceId != null)
    }

    @Test fun `events replayed after a dropped connection are not read twice`() {
        val r = rig(); r.start()
        r.tts.hold = CompletableDeferred()
        r.say("こんにちは")
        eventually(message = "first sentence started") { r.tts.started.size == 1 }
        runBlocking { delay(500) } // 3 文とも届いている(まだ ack していない)

        r.client.reconnectNow()
        eventually(10_000, "reconnected") { r.states.count { it == ConnectionState.CONNECTED } >= 2 }
        runBlocking { delay(300) } // Gateway が未 ack の 3 件を再送してくる
        r.tts.hold!!.complete(Unit)

        eventually(message = "3 sentences") { r.tts.spoken.size == 3 }
        runBlocking { delay(300) }
        assertEquals(listOf("「こんにちは」ですね。", "これはモックの応答です。", "実際のモデルは動いていません。"), r.tts.spoken.toList(), "重複して読まない")
        eventually(message = "ack position") { r.positions.lastEventId == "3" }
    }

    @Test fun `an ambiguous request is confirmed by voice and then reaches Codex`() {
        val r = rig(); r.start()
        r.say("JEPAの実験の件")
        eventually(message = "prompt") { r.tts.spoken.any { it.startsWith("どちらですか。1番、Codex") } }
        r.idle()
        r.say("1番")
        eventually(message = "Codex answer") { "作業が完了しました。実験の精度は0.9でした。" in r.tts.spoken }
        assertTrue("ファイルを調べています" !in r.tts.spoken, "途中経過は読まない")
    }

    @Test fun `a busy Codex session is explained out loud`() {
        val r = rig(); r.start()
        r.say("busyの確認をCodexで")
        eventually(message = "busy notice") { r.tts.spoken.any { it.contains("別のアプリでそのセッションが使用中") } }
        r.idle()
    }

    @Test fun `the latest Codex answer can be read back`() {
        val r = rig(); r.start()
        r.say("Codexの返事を読んで")
        eventually(message = "read back") { "前回の実験は精度0.9で完了しました。" in r.tts.spoken }
    }

    @Test fun `a wrong token is reported once and does not cause a reconnect loop`() {
        val r = rig(token = "wrong-token-0123456789abcdefghij")
        r.controller.start()
        eventually(15_000, "AUTH_FAILED") { r.client.state.value == ConnectionState.AUTH_FAILED }
        eventually(message = "spoken") { r.tts.spoken.any { it.contains("認証に失敗しました") } }
        runBlocking { delay(1000) }
        assertEquals(ConnectionState.AUTH_FAILED, r.client.state.value)
        assertEquals(1, r.states.count { it == ConnectionState.CONNECTING }, "再接続を繰り返さない")
    }

    @Test fun `a second connection with the same token replaces the first, which does not fight back`() {
        val r = rig(); r.start()
        val second = GatewayClient(r.gateway.url, TOKEN, InMemoryPositionStore(), r.scope)
        second.start()
        eventually(15_000, "second connected") { second.state.value == ConnectionState.CONNECTED }
        eventually(message = "first replaced") { r.client.state.value == ConnectionState.REPLACED }
        runBlocking { delay(800) }
        assertEquals(ConnectionState.REPLACED, r.client.state.value)
        assertEquals(ConnectionState.CONNECTED, second.state.value)
        second.stop()
    }
}

class ConnectionFailureTest {
    @Test fun `an unreachable gateway reports why, and keeps retrying`() {
        val port = ServerSocket(0).use { it.localPort } // 何も待ち受けていないポート
        val scope = singleThreadScope()
        val client = GatewayClient("ws://127.0.0.1:$port", TOKEN, InMemoryPositionStore(), scope, backoff = Backoff(baseMs = 100, maxMs = 200))
        try {
            client.start()
            eventually(10_000, "error reported") { client.lastError.value != null }
            assertTrue(client.state.value != ConnectionState.CONNECTED)
            val first = client.lastError.value
            assertTrue(!first.isNullOrBlank())
        } finally {
            client.stop()
            scope.cancel()
        }
    }
}
