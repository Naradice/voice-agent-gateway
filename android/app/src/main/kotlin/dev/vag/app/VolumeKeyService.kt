package dev.vag.app

import android.accessibilityservice.AccessibilityService
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

/**
 * 音量下キーを PTT として受け取る(画面ロック中も受け取れる見込み。機種により差があるため実機で確認する)。
 * Android はアプリが任意のハードウェアボタンを常時横取りすることを許していないので、ユーザー補助サービスの
 * 「キー入力の取得」を使う。画面の内容は読まない(AccessibilityEvent は無視する)。
 *
 * 取り込むのは、(1) 設定でオン (2) 音声サービスが動いている、の両方のときだけ。それ以外は音量を通常どおり変える。
 */
class VolumeKeyService : AccessibilityService() {
    override fun onServiceConnected() {
        super.onServiceConnected()
        _connected.value = true
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        _connected.value = false
        return super.onUnbind(intent)
    }

    override fun onKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) return false
        if (!Settings(this).volumeDownPtt || VoiceRuntime.controller.value == null) return false
        // 押した瞬間だけ PTT を押す(長押しの繰り返しは無視)。離したときも、音量を変えないよう取り込む。
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) VoiceRuntime.pressPtt()
        return true
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit

    companion object {
        /** サービスが許可されて動いているか(画面の表示用)。 */
        private val _connected = kotlinx.coroutines.flow.MutableStateFlow(false)
        val connected: kotlinx.coroutines.flow.StateFlow<Boolean> = _connected
    }
}
