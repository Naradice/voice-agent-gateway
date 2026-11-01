package dev.vag.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import dev.vag.core.PositionStore
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** トークンは Android Keystore の鍵(端末の外に出せない)で暗号化して保存する。平文でファイルに残さない。 */
object TokenCipher {
    private const val ALIAS = "vag_token_key"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val out = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    /** 復号できなければ null(アプリの再インストールで鍵が失われた場合など)。その場合は設定し直す。 */
    fun decrypt(encoded: String): String? = try {
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
        String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
    } catch (_: Exception) {
        null
    }
}

/**
 * 接続先・トークン・読み上げの位置の保存。同期的に読み書きできる SharedPreferences を使う
 * (位置の保存は読み上げのたびに呼ばれるため。設計書では DataStore としていたが、ここは同期の方が単純)。
 */
class Settings(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("vag", Context.MODE_PRIVATE)

    var url: String?
        get() = prefs.getString("url", null)
        set(v) { prefs.edit().putString("url", v?.trim()).apply() }

    var token: String?
        get() = prefs.getString("token", null)?.let { TokenCipher.decrypt(it) }
        set(v) { prefs.edit().apply { if (v.isNullOrBlank()) remove("token") else putString("token", TokenCipher.encrypt(v.trim())) }.apply() }

    /** 接続先とトークンが保存されているか(トークンは復号せず、あるかどうかだけ見る)。 */
    /** イヤホンのボタン(メディアキー)で PTT を押す。音楽アプリのボタン操作を奪うので、切り替えられるようにする。 */
    var earphoneButton: Boolean
        get() = prefs.getBoolean("earphoneButton", true)
        set(v) { prefs.edit().putBoolean("earphoneButton", v).apply() }

    /** 音量下キーで話す(ユーザー補助サービスの許可が別に必要)。オンの間、アプリ動作中は音量下キーで音量を変えられない。 */
    var volumeDownPtt: Boolean
        get() = prefs.getBoolean("volumeDownPtt", false)
        set(v) { prefs.edit().putBoolean("volumeDownPtt", v).apply() }

    val isConfigured: Boolean get() = !url.isNullOrBlank() && prefs.contains("token")

    val positions: PositionStore = object : PositionStore {
        override var lastEventId: String?
            get() = prefs.getString("lastEventId", null)
            set(v) { prefs.edit().apply { if (v == null) remove("lastEventId") else putString("lastEventId", v) }.apply() }
        override var instanceId: String?
            get() = prefs.getString("instanceId", null)
            set(v) { prefs.edit().apply { if (v == null) remove("instanceId") else putString("instanceId", v) }.apply() }
    }
}
