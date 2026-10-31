package dev.vag.app

import android.content.Context
import android.media.AudioAttributes
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import dev.vag.core.TtsPort
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume

/** Android の TextToSpeech による読み上げ。読み終えるまで中断し、コルーチンがキャンセルされたら止める。 */
class AndroidTts(context: Context) : TtsPort {
    private val ready = CompletableDeferred<Boolean>()
    private val waiting = ConcurrentHashMap<String, CancellableContinuation<Unit>>()
    private lateinit var tts: TextToSpeech

    init {
        tts = TextToSpeech(context.applicationContext) { status -> onInit(status == TextToSpeech.SUCCESS) }
    }

    private fun onInit(ok: Boolean) {
        if (ok) {
            tts.language = Locale.JAPAN
            tts.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onDone(utteranceId: String?) = finish(utteranceId)
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) = finish(utteranceId)
                override fun onError(utteranceId: String?, errorCode: Int) = finish(utteranceId)
                override fun onStop(utteranceId: String?, interrupted: Boolean) = finish(utteranceId)
            })
        }
        ready.complete(ok)
    }

    private fun finish(id: String?) {
        val cont = id?.let { waiting.remove(it) } ?: return
        if (cont.isActive) cont.resume(Unit)
    }

    override suspend fun speak(text: String) {
        if (!ready.await()) return
        suspendCancellableCoroutine { cont ->
            val id = UUID.randomUUID().toString()
            waiting[id] = cont
            cont.invokeOnCancellation { waiting.remove(id); tts.stop() }
            if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) {
                waiting.remove(id)
                if (cont.isActive) cont.resume(Unit)
            }
        }
    }

    override fun stop() { tts.stop() }

    fun shutdown() { tts.shutdown() }
}
