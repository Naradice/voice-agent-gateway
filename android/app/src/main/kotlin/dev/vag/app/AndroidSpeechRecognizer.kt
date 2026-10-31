package dev.vag.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import dev.vag.core.SpeechRecognizerPort
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/** Android の SpeechRecognizer による音声認識。メインスレッドから呼ぶこと(コントローラはメインスレッドで動く)。 */
class AndroidSpeechRecognizer(private val context: Context) : SpeechRecognizerPort {
    private var recognizer: SpeechRecognizer? = null

    override suspend fun listen(endOfSpeech: () -> Unit): String? {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) return null
        return suspendCancellableCoroutine { cont ->
            val r = SpeechRecognizer.createSpeechRecognizer(context)
            recognizer = r

            fun done(text: String?) {
                if (cont.isActive) cont.resume(text)
                r.destroy()
                if (recognizer === r) recognizer = null
            }

            r.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() = endOfSpeech()
                override fun onError(error: Int) = done(null)
                override fun onResults(results: Bundle?) =
                    done(results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull())
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })

            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ja-JP")
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            }
            r.startListening(intent)
            cont.invokeOnCancellation { r.cancel(); r.destroy() }
        }
    }

    /** 無音検出を待たず、ここまでの入力で確定する。 */
    override fun finish() { recognizer?.stopListening() }

    override fun cancel() { recognizer?.cancel() }
}
