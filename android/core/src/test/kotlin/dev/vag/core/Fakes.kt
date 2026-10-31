package dev.vag.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.concurrent.CopyOnWriteArrayList

@OptIn(ExperimentalCoroutinesApi::class)
fun singleThreadScope() = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))

/** 条件が満たされるまで待つ(最大 timeoutMs)。満たされなければテストを失敗させる。 */
fun eventually(timeoutMs: Long = 5000, message: String = "condition", check: () -> Boolean) = runBlocking {
    try {
        withTimeout(timeoutMs) { while (!check()) delay(10) }
    } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
        throw AssertionError("timed out waiting for: $message")
    }
}

class FakeRecognizer : SpeechRecognizerPort {
    // null(聞き取れなかった)も入れられるように、キューではなく同期したリストを使う
    val results: MutableList<String?> = java.util.Collections.synchronizedList(ArrayList())
    @Volatile var gate: CompletableDeferred<Unit>? = null
    @Volatile var listening = false
    @Volatile var finishCalls = 0

    override suspend fun listen(onEndOfSpeech: () -> Unit): String? {
        listening = true
        try {
            gate?.await()
            onEndOfSpeech()
            return if (results.isEmpty()) null else results.removeAt(0)
        } finally {
            listening = false
        }
    }
    override fun finish() { finishCalls++; gate?.complete(Unit) }
    override fun cancel() {}
}

class FakeTts : TtsPort {
    val started = CopyOnWriteArrayList<String>()
    val spoken = CopyOnWriteArrayList<String>()   // 最後まで読み終えたもの
    @Volatile var hold: CompletableDeferred<Unit>? = null
    @Volatile var stops = 0

    override suspend fun speak(text: String) {
        started.add(text)
        hold?.await()
        delay(5)
        spoken.add(text)
    }
    override fun stop() { stops++ }
}

class FakeLink : GatewayLink {
    override val state = MutableStateFlow(ConnectionState.DISCONNECTED)
    private val channel = Channel<ServerMessage>(Channel.UNLIMITED)
    override val incoming: Flow<ServerMessage> = channel.receiveAsFlow()
    val sent = CopyOnWriteArrayList<ClientMessage>()

    override fun start() {}
    override fun stop() {}
    override fun send(msg: ClientMessage): Boolean {
        if (state.value != ConnectionState.CONNECTED) return false
        sent.add(msg)
        return true
    }
    fun deliver(m: ServerMessage) { channel.trySend(m) }
    fun speech(id: Int?, text: String, priority: Priority = Priority.NORMAL) =
        deliver(SpeechEnqueue(eventId = id?.toString(), ephemeral = if (id == null) true else null, priority = priority, text = text))
    inline fun <reified T : ClientMessage> sentOf(): List<T> = sent.filterIsInstance<T>()
}
