package dev.vag.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import dev.vag.core.ConnectionTestResult
import dev.vag.core.VoiceState
import dev.vag.core.parseConnectionCode
import dev.vag.core.testConnection
import dev.vag.core.tokenFingerprint
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { startVoice() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                MainScreen(
                    onSaveSettings = { url, token ->
                        Settings(this).apply { this.url = url; if (!token.isNullOrBlank()) this.token = token }
                        VoiceRuntime.stop()
                        requestPermissionsThenStart()
                    },
                )
            }
        }
        requestPermissionsThenStart()
    }

    private fun requestPermissionsThenStart() {
        val needed = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) startVoice() else permissionRequest.launch(needed.toTypedArray())
    }

    /** マイクの許可があり、接続先が設定されているときだけ、サービスを(画面が見えている間に)起動する。 */
    private fun startVoice() {
        val mic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (mic && Settings(this).isConfigured) ContextCompat.startForegroundService(this, Intent(this, VoiceService::class.java))
    }
}

private fun pttLabel(s: VoiceState) = when (s) {
    VoiceState.DISCONNECTED -> "未接続"
    VoiceState.IDLE -> "話す"
    VoiceState.LISTENING -> "聞いています\n(もう一度押すと確定)"
    VoiceState.TRANSCRIBING -> "認識中…"
    VoiceState.SENDING -> "送信中…"
    VoiceState.SPEAKING -> "読み上げ中\n(押すと止めて話す)"
}

@Composable
private fun MainScreen(onSaveSettings: (String, String?) -> Unit) {
    val context = LocalContext.current
    val controller by VoiceRuntime.controller.collectAsState()
    val status by VoiceRuntime.status.collectAsState()
    val lastError by VoiceRuntime.lastError.collectAsState()
    val voiceState by remember(controller) { controller?.state ?: MutableStateFlow(VoiceState.DISCONNECTED) }.collectAsState()
    val heard by remember(controller) { controller?.heard ?: MutableStateFlow<String?>(null) }.collectAsState()
    val spoken by remember(controller) { controller?.spoken ?: MutableStateFlow<String?>(null) }.collectAsState()
    var showSettings by remember { mutableStateOf(false) }
    val settings = Settings(context)
    // 保存済みトークンの確認コード(トークン本体は出さない)。PC の `npm run gateway:code` の表示と比べる。
    val savedToken = remember(showSettings, controller) { settings.token }

    // 「未接続」の理由を画面で分かるようにする(許可がない・未設定・接続できない、は別の状況)
    val hint = when {
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED ->
            "マイクの許可がありません。端末の設定でこのアプリにマイクを許可してください。"
        !settings.isConfigured -> "接続先とトークンが未設定です。下の「設定」から入力してください。"
        else -> null
    }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(status, style = MaterialTheme.typography.titleMedium)
        settings.url?.let { Text("接続先: $it", style = MaterialTheme.typography.bodySmall) }
        savedToken?.let { Text("トークン確認コード: ${tokenFingerprint(it)}", style = MaterialTheme.typography.bodySmall) }
        hint?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        lastError?.let { Text("接続エラー: $it", color = MaterialTheme.colorScheme.error) }
        // 画面を見ずに使えるよう、ボタンは画面の大半を占める大きさにする
        Button(onClick = { VoiceRuntime.pressPtt() }, modifier = Modifier.fillMaxWidth().weight(1f)) {
            Text(pttLabel(voiceState), style = MaterialTheme.typography.headlineMedium)
        }
        Text("聞き取り: ${heard ?: "—"}")
        Text("読み上げ: ${spoken ?: "—"}")
        TextButton(onClick = { showSettings = true }) { Text("設定") }
    }

    if (showSettings) {
        SettingsDialog(
            initialUrl = settings.url ?: "",
            savedToken = savedToken,
            onDismiss = { showSettings = false },
            onSave = { u, t -> showSettings = false; onSaveSettings(u, t) },
        )
    }
}

private fun describe(r: ConnectionTestResult) = when (r) {
    is ConnectionTestResult.Ok -> "接続できました(デバイス: ${r.deviceId})。接続先もトークンも正しいです。"
    ConnectionTestResult.AuthFailed -> "Gateway には届きましたが、トークンが違います。確認コードを PC の表示と比べてください。"
    is ConnectionTestResult.Failed -> "接続できません: ${r.reason}"
}

/**
 * 接続先とトークンの設定。
 * - トークンを空欄のまま保存すると、保存済みのトークンをそのまま使う(毎回入力し直さなくてよい)。
 * - 入力ミスの確認: 確認コード(PC の `npm run gateway:code` と同じ値か)、接続テスト、表示の切り替え。
 * - 長いトークンを手で打たずに済むよう、クリップボードの「接続コード」(ws://host:port#token)から一括で設定できる。
 */
@Composable
private fun SettingsDialog(initialUrl: String, savedToken: String?, onDismiss: () -> Unit, onSave: (String, String?) -> Unit) {
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(initialUrl) }
    var token by remember { mutableStateOf("") } // 空 = 保存済みのトークンを使う
    var reveal by remember { mutableStateOf(false) }
    var testing by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }

    val effectiveToken = token.trim().ifEmpty { savedToken ?: "" }
    val canUse = url.isNotBlank() && effectiveToken.isNotEmpty()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Gateway の設定") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                OutlinedTextField(url, { url = it; message = null }, label = { Text("接続先 (ws://100.x.x.x:8787)") }, singleLine = true)
                Spacer(Modifier.height(4.dp))
                OutlinedTextField(
                    token, { token = it; message = null },
                    label = { Text(if (savedToken != null) "トークン(空欄なら保存済みを使う)" else "トークン") },
                    singleLine = true,
                    visualTransformation = if (reveal) VisualTransformation.None else PasswordVisualTransformation(),
                )
                if (effectiveToken.isNotEmpty()) {
                    Text("トークン確認コード: ${tokenFingerprint(effectiveToken)}", style = MaterialTheme.typography.bodyMedium)
                    Text("PC の「npm run gateway:code」の確認コードと同じなら、入力は正しいです。", style = MaterialTheme.typography.bodySmall)
                }
                Row {
                    TextButton(onClick = { reveal = !reveal }) { Text(if (reveal) "隠す" else "表示") }
                    TextButton(onClick = { clipboard.getText()?.text?.trim()?.takeIf { it.isNotEmpty() }?.let { token = it; message = null } }) { Text("トークンを貼り付け") }
                }
                TextButton(onClick = {
                    val code = clipboard.getText()?.text?.let { parseConnectionCode(it) }
                    if (code != null) { url = code.url; token = code.token; message = "接続コードを読み込みました。「接続テスト」で確認してください。" }
                    else message = "クリップボードに接続コードがありません(PC の「npm run gateway:code」で表示できます)"
                }) { Text("接続コードを貼り付け") }
                TextButton(
                    enabled = canUse && !testing,
                    onClick = {
                        testing = true
                        message = "テスト中…"
                        scope.launch { message = describe(testConnection(url.trim(), effectiveToken)); testing = false }
                    },
                ) { Text("接続テスト") }
                message?.let { Text(it) }
            }
        },
        confirmButton = { TextButton(onClick = { onSave(url.trim(), token.trim().ifEmpty { null }) }, enabled = canUse) { Text("保存して接続") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}
