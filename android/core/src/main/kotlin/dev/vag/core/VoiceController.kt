package dev.vag.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.util.UUID

/** 設計書 §3.3 の状態。Agent の処理中も IDLE に戻り、新しい指示や中断を受け付ける。 */
enum class VoiceState { DISCONNECTED, IDLE, LISTENING, TRANSCRIBING, SENDING, SPEAKING }

/**
 * PTT → 音声認識 → 送信 → 読み上げ、の流れを統括する(設計書 §3.2)。Android の API には依存しない。
 *
 * scope は単一スレッドに閉じたものを渡すこと(状態を排他制御なしで扱うため)。
 *
 * 方針:
 * - マイクは PTT のときだけ使う。確認要求への回答も、あらためて PTT で受ける。
 * - 聞いている間(LISTENING / TRANSCRIBING)は読み上げない(音声がマイクに回り込むのを避ける)。
 * - 読み上げ中に PTT が押されたら、読み上げを止めて聞く(割り込み)。
 * - critical(エラー・確認の依頼)は、読み上げ中の通常の読み上げに割り込む。止められた分は後で読み直す。
 * - 送信の結果が分からない要求は、再接続後に同じ requestId で送り直す。Gateway は二重に実行しない。
 */
class VoiceController(
    private val link: GatewayLink,
    private val recognizer: SpeechRecognizerPort,
    private val tts: TtsPort,
    private val positions: PositionStore,
    private val scope: CoroutineScope,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val responseTimeoutMs: Long = 20_000,
) {
    private val _state = MutableStateFlow(VoiceState.DISCONNECTED)
    val state: StateFlow<VoiceState> = _state
    private val _heard = MutableStateFlow<String?>(null)
    /** 最後に認識した発話(画面表示用)。 */
    val heard: StateFlow<String?> = _heard
    private val _spoken = MutableStateFlow<String?>(null)
    /** 最後に読み上げた文(画面表示用)。 */
    val spoken: StateFlow<String?> = _spoken

    private val queue = SpeechQueue(positions.lastEventId?.toLongOrNull())
    private val inflight = LinkedHashMap<String, MessageSend>()
    private var pending: Pending? = null
    private var speakJob: Job? = null
    private var listenJob: Job? = null
    private var current: SpeechItem? = null
    private var interruptMode: InterruptMode? = null
    private val wake = Channel<Unit>(Channel.CONFLATED)

    private class Pending(val requestId: String, val original: MessageSend, val candidates: List<Candidate>, var misses: Int = 0)
    private enum class InterruptMode { DONE, REQUEUE }

    fun start() {
        link.start()
        scope.launch { link.state.collect { onConnection(it) } }
        scope.launch { link.incoming.collect { onMessage(it) } }
        scope.launch { speakerLoop() }
    }

    fun stop() {
        listenJob?.cancel()
        speakJob?.cancel()
        recognizer.cancel()
        tts.stop()
        link.stop()
    }

    // ---- PTT ----

    fun onPttPressed() {
        scope.launch {
            when (_state.value) {
                VoiceState.DISCONNECTED -> speakLocal("Gatewayに接続されていません。", Priority.HIGH)
                VoiceState.LISTENING -> recognizer.finish() // 無音検出を待たずに確定
                VoiceState.TRANSCRIBING, VoiceState.SENDING -> Unit
                VoiceState.SPEAKING -> { bargeIn(); startListening() }
                VoiceState.IDLE -> startListening()
            }
        }
    }

    private fun startListening() {
        link.send(PttStart) // モデルの先読みを始めさせる(認識の間に読み込みが進む)
        _state.value = VoiceState.LISTENING
        listenJob = scope.launch {
            val text = try {
                recognizer.listen { scope.launch { if (_state.value == VoiceState.LISTENING) _state.value = VoiceState.TRANSCRIBING } }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
            if (text.isNullOrBlank()) {
                speakLocal("聞き取れませんでした。もう一度お願いします。", Priority.NORMAL)
                toIdle()
            } else {
                _heard.value = text
                handleTranscript(text)
            }
        }
    }

    private fun handleTranscript(text: String) {
        pending?.let { return handleAnswer(it, text) }
        val msg = MessageSend(newId(), text)
        inflight[msg.requestId] = msg
        _state.value = VoiceState.SENDING
        if (!link.send(msg)) {
            // つながっていない。再接続したら送り直す。
            speakLocal("接続を待っています。", Priority.NORMAL)
            toIdle()
        } else {
            watchResponse(msg.requestId)
        }
    }

    private fun handleAnswer(p: Pending, text: String) {
        when (val c = parseChoice(text, p.candidates.size)) {
            is Choice.Pick -> {
                pending = null
                inflight[p.requestId] = p.original // 結果不明で再接続した場合は、元の指示を送り直して Gateway の状態を再取得する
                _state.value = VoiceState.SENDING
                if (!link.send(RoutingConfirm.pick(p.requestId, c.index))) toIdle() else watchResponse(p.requestId)
            }
            Choice.Cancel -> {
                pending = null
                link.send(RoutingConfirm.cancel(p.requestId))
                toIdle()
            }
            Choice.Unknown -> {
                p.misses++
                if (p.misses >= 3) {
                    pending = null
                    link.send(RoutingConfirm.cancel(p.requestId))
                    speakLocal("分からなかったので、キャンセルしました。", Priority.HIGH)
                } else {
                    speakLocal("番号で答えるか、キャンセルと言ってください。", Priority.HIGH)
                }
                toIdle()
            }
        }
    }

    /** 応答が来ない場合に、SENDING のまま固まらないようにする。 */
    private fun watchResponse(requestId: String) {
        scope.launch {
            delay(responseTimeoutMs)
            if (inflight.containsKey(requestId) && _state.value == VoiceState.SENDING) {
                speakLocal("応答がありません。しばらくしてからお試しください。", Priority.HIGH)
                toIdle()
            }
        }
    }

    // ---- 接続・受信 ----

    private fun onConnection(s: ConnectionState) {
        if (s == ConnectionState.CONNECTED) {
            if (_state.value == VoiceState.DISCONNECTED) _state.value = VoiceState.IDLE
            // 結果が分からない要求を、同じ requestId で送り直す(Gateway は二重に実行せず、前回の結果を返す)
            for (m in inflight.values.toList()) link.send(m)
        } else {
            if (_state.value == VoiceState.IDLE) _state.value = VoiceState.DISCONNECTED
            if (s == ConnectionState.AUTH_FAILED) speakLocal("認証に失敗しました。設定のトークンを確認してください。", Priority.CRITICAL)
        }
    }

    private fun onMessage(m: ServerMessage) {
        when (m) {
            is HelloOk -> {
                val id = m.instanceId
                if (id != null && positions.instanceId != id) {
                    // 別の Gateway(または作り直した DB)。イベント番号は 1 から振り直されているので、前の位置は捨てる。
                    positions.instanceId = id
                    positions.lastEventId = null
                    queue.resetRemote()
                }
            }
            is SpeechEnqueue -> onSpeech(m)
            is RequestAccepted -> { inflight.remove(m.requestId); if (_state.value == VoiceState.SENDING) toIdle() }
            is RequestRejected -> {
                inflight.remove(m.requestId)
                if (pending?.requestId == m.requestId) pending = null
                speakLocal(m.message, Priority.CRITICAL)
                if (_state.value == VoiceState.SENDING) toIdle()
            }
            is RoutingConfirmationRequired -> {
                val original = inflight.remove(m.requestId)
                // 再接続後の再送などで、すでに回答を送った要求に確認が再び来ることがある。未知の要求は無視しない(利用者に確認する)。
                pending = Pending(m.requestId, original ?: MessageSend(m.requestId, ""), m.candidates)
                speakLocal(m.prompt, Priority.HIGH)
                if (_state.value == VoiceState.SENDING) toIdle()
            }
            is ErrorMessage -> Unit // プロトコル上の誤り。端末のバグか版の不一致。利用者には読み上げない
        }
    }

    private fun onSpeech(m: SpeechEnqueue) {
        val id = m.eventId?.toLongOrNull()
        if (m.ephemeral == true || id == null) {
            queue.offerLocal(m.priority, m.text, m.sessionId)
        } else {
            when (val o = queue.offerRemote(id, m.priority, m.text, m.sessionId)) {
                Offer.Accepted -> Unit
                is Offer.Duplicate -> {
                    // 再接続の再送で、読み上げ済みなのに ack が届いていなかったものが来た。読み直さず、ack だけ返す。
                    if (o.alreadySpoken) queue.acked?.let { link.send(Ack(it.toString())) }
                    return
                }
            }
        }
        preemptIfCritical(m.priority)
        wake.trySend(Unit)
    }

    // ---- 読み上げ ----

    private fun speakLocal(text: String, priority: Priority) {
        queue.offerLocal(priority, text)
        preemptIfCritical(priority)
        wake.trySend(Unit)
    }

    private fun preemptIfCritical(priority: Priority) {
        val cur = current ?: return
        if (priority == Priority.CRITICAL && cur.priority != Priority.CRITICAL) {
            interruptMode = InterruptMode.REQUEUE
            speakJob?.cancel()
            tts.stop()
        }
    }

    /** PTT による割り込み。読み上げ中の1文は、聞き手が飛ばしたものとして読み終えた扱いにする。 */
    private fun bargeIn() {
        interruptMode = InterruptMode.DONE
        speakJob?.cancel()
        tts.stop()
    }

    private suspend fun speakerLoop() {
        while (true) {
            // 聞いている間は話さない
            _state.first { it != VoiceState.LISTENING && it != VoiceState.TRANSCRIBING }
            val item = queue.poll()
            if (item == null) {
                wake.receive()
                continue
            }
            current = item
            interruptMode = null
            _state.value = VoiceState.SPEAKING
            _spoken.value = item.text
            val job = scope.launch { tts.speak(item.text) }
            speakJob = job
            job.join()
            speakJob = null
            current = null
            val cancelled = job.isCancelled
            when {
                !cancelled || interruptMode == InterruptMode.DONE -> queue.done(item)?.let { ack(it) }
                else -> queue.requeue(item) // 割り込まれた。後で読み直す
            }
            interruptMode = null
            if (_state.value == VoiceState.SPEAKING) toIdle()
        }
    }

    private fun ack(position: Long) {
        positions.lastEventId = position.toString() // 先に保存してから送る(送れなくても次回の hello で伝わる)
        link.send(Ack(position.toString()))
    }

    private fun toIdle() {
        _state.value = if (link.state.value == ConnectionState.CONNECTED) VoiceState.IDLE else VoiceState.DISCONNECTED
    }
}
