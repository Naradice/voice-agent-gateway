package dev.vag.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * 画面を閉じる・ロックしても、Gateway からの読み上げを受け取り続けるためのフォアグラウンドサービス(設計書 §3.4)。
 * マイクの種類で起動する。Android 14 以降は、アプリが見えている状態で起動する必要がある(MainActivity から開始する)。
 * PTT 待機中はマイクを使わない(音声認識を始めたときだけ使う)。
 */
class VoiceService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var job: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Voice Agent", NotificationManager.IMPORTANCE_LOW))
        ServiceCompat.startForeground(this, ID, notification("起動中"), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)

        VoiceRuntime.start(this)
        job = scope.launch {
            VoiceRuntime.status.collect { nm.notify(ID, notification(it)) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            VoiceRuntime.stop()
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        job?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    private fun notification(text: String) = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(android.R.drawable.ic_btn_speak_now)
        .setContentTitle("Voice Agent")
        .setContentText(text)
        .setOngoing(true)
        .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
        .addAction(0, "停止", PendingIntent.getService(this, 1, Intent(this, VoiceService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE))
        .build()

    companion object {
        private const val CHANNEL = "voice_agent"
        private const val ID = 1
        const val ACTION_STOP = "dev.vag.app.STOP"
    }
}
