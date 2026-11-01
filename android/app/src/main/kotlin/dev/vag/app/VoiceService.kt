package dev.vag.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.ToneGenerator
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import dev.vag.core.Notices
import dev.vag.core.VoiceState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import android.media.VolumeProvider
import kotlinx.coroutines.launch

/**
 * 画面を閉じる・ロックしても、Gateway からの読み上げを受け取り続けるためのフォアグラウンドサービス(設計書 §3.4)。
 * マイクの種類で起動する。Android 14 以降は、アプリが見えている状態で起動する必要がある(MainActivity から開始する)。
 * PTT 待機中はマイクを使わない(音声認識を始めたときだけ使う)。
 *
 * 画面を見ずに話し始めるための入口(いずれも実機での確認が必要な第一版):
 * - 通知の「話す」ボタン(ロック画面の通知にも出す)
 * - イヤホンのボタン(再生/一時停止・ヘッドセットボタン)。MediaSession でメディアキーを受け取る
 * - 聞き始めのビープ音(画面を見なくても、聞き始めたことが分かる)
 */
class VoiceService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var mediaSession: MediaSession? = null
    private var tone: ToneGenerator? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Voice Agent", NotificationManager.IMPORTANCE_LOW)
                .apply { lockscreenVisibility = Notification.VISIBILITY_PUBLIC }, // ロック画面にも状態と「話す」ボタンを出す
        )
        nm.createNotificationChannel(NotificationChannel(NOTICE_CHANNEL, "待機メッセージ", NotificationManager.IMPORTANCE_DEFAULT))
        try {
            ServiceCompat.startForeground(this, ID, notification("起動中"), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } catch (_: Exception) {
            // アプリが見えていない状態での再起動など、マイクのサービスを開始できない場合。アプリを開き直せば再開できる。
            stopSelf()
            return
        }

        VoiceRuntime.syncSettings(this)
        VoiceRuntime.start(this)
        scope.launch { VoiceRuntime.status.collect { nm.notify(ID, notification(it)) } }
        // 待機メッセージは読み上げず、通知に件数を出す。「読む」を押す(または「待機メッセージを読んで」と話す)と読み上げる。
        scope.launch { VoiceRuntime.notices.collect { showNotices(nm, it) } }
        scope.launch {
            combine(VoiceRuntime.earphoneButton, VoiceRuntime.volumeDownPtt) { e, v -> e to v }
                .collect { (e, v) -> applyMediaSession(e, v) }
        }
        scope.launch {
            var previous = VoiceState.DISCONNECTED
            VoiceRuntime.voiceState.collect { now ->
                if (now == VoiceState.LISTENING && previous != VoiceState.LISTENING) beep()
                previous = now
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                VoiceRuntime.stop()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_READ_NOTICES -> {
                VoiceRuntime.readNotices()
                return START_STICKY
            }
            ACTION_PTT -> {
                VoiceRuntime.pressPtt()
                return START_STICKY
            }
        }
        // 設定が変わって再度起動された場合(サービスが動いたまま)にも、接続を張り直す。すでに動いていれば何もしない。
        VoiceRuntime.start(this)
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        mediaSession?.release()
        mediaSession = null
        tone?.release()
        tone = null
        super.onDestroy()
    }

    /**
     * イヤホンのボタンと音量下キーを PTT として受け取る。再生中の MediaSession として登録すると、システムがメディアキーを
     * ここに届ける(画面ロック中も)。音量キーは、リモート再生の音量(VolumeProvider)として登録すると、画面が消えている間も
     * 届く。ユーザー補助サービス(VolumeKeyService)は画面が消えている間はキーを受け取れないため、その穴を埋める。
     * どちらも音楽アプリの操作・音量調整を奪うので、画面のスイッチで切り替えられる。
     */
    private fun applyMediaSession(earphone: Boolean, volumeDown: Boolean) {
        mediaSession?.release()
        mediaSession = null
        if (!earphone && !volumeDown) return
        val session = MediaSession(this, "VoiceAgentPtt")
        session.setCallback(object : MediaSession.Callback() {
            override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                if (!VoiceRuntime.earphoneButton.value) return false
                val event = keyEventOf(mediaButtonIntent) ?: return false
                if (event.keyCode !in PTT_KEYS) return false
                if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) VoiceRuntime.pressPtt()
                return true
            }
        })
        if (volumeDown) {
            session.setPlaybackToRemote(object : VolumeProvider(VOLUME_CONTROL_RELATIVE, 100, 50) {
                override fun onAdjustVolume(direction: Int) {
                    // 音量下(direction < 0)だけを PTT にする。音量上は何もしない。
                    if (direction < 0) scope.launch { VoiceRuntime.pressPtt() }
                }
            })
        }
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE)
                .setState(PlaybackState.STATE_PLAYING, 0L, 1f)
                .build(),
        )
        session.isActive = true
        mediaSession = session
    }

    @Suppress("DEPRECATION")
    private fun keyEventOf(intent: Intent): KeyEvent? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)

    private fun beep() {
        val t = tone ?: ToneGenerator(AudioManager.STREAM_MUSIC, 70).also { tone = it }
        t.startTone(ToneGenerator.TONE_PROP_BEEP, 150)
    }

    /** 未読が増えたときだけ鳴らす(件数の更新では鳴らさない)。0 件になったら消す。 */
    private fun showNotices(nm: NotificationManager, n: Notices) {
        if (n.count <= 0) { nm.cancel(NOTICE_ID); return }
        nm.notify(
            NOTICE_ID,
            NotificationCompat.Builder(this, NOTICE_CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("待機メッセージ ${n.count}件")
                .setContentText(n.latest ?: "")
                .setStyle(NotificationCompat.BigTextStyle().bigText(n.latest ?: ""))
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE) // ロック画面には件数だけ(内容は隠す)
                .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
                .addAction(0, "読む", serviceIntent(3, ACTION_READ_NOTICES))
                .build(),
        )
    }

    private fun serviceIntent(requestCode: Int, action: String) =
        PendingIntent.getService(this, requestCode, Intent(this, VoiceService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE)

    private fun notification(text: String) = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(android.R.drawable.ic_btn_speak_now)
        .setContentTitle("Voice Agent")
        .setContentText(text)
        .setOngoing(true)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
        .addAction(0, "話す", serviceIntent(2, ACTION_PTT))
        .addAction(0, "停止", serviceIntent(1, ACTION_STOP))
        .build()

    companion object {
        private const val CHANNEL = "voice_agent"
        private const val ID = 1
        private const val NOTICE_ID = 2
        private const val NOTICE_CHANNEL = "voice_agent_notices"
        const val ACTION_STOP = "dev.vag.app.STOP"
        const val ACTION_PTT = "dev.vag.app.PTT"
        const val ACTION_READ_NOTICES = "dev.vag.app.READ_NOTICES"
        private val PTT_KEYS = setOf(
            KeyEvent.KEYCODE_HEADSETHOOK,
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_MEDIA_PLAY,
            KeyEvent.KEYCODE_MEDIA_PAUSE,
        )
    }
}
