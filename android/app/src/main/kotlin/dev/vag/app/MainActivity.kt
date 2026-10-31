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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import dev.vag.core.VoiceState
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { startVoice() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                MainScreen(
                    onSaveSettings = { url, token ->
                        Settings(this).apply { this.url = url; this.token = token }
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
private fun MainScreen(onSaveSettings: (String, String) -> Unit) {
    val context = LocalContext.current
    val controller by VoiceRuntime.controller.collectAsState()
    val status by VoiceRuntime.status.collectAsState()
    val lastError by VoiceRuntime.lastError.collectAsState()
    val voiceState by remember(controller) { controller?.state ?: MutableStateFlow(VoiceState.DISCONNECTED) }.collectAsState()
    val heard by remember(controller) { controller?.heard ?: MutableStateFlow<String?>(null) }.collectAsState()
    val spoken by remember(controller) { controller?.spoken ?: MutableStateFlow<String?>(null) }.collectAsState()
    var showSettings by remember { mutableStateOf(false) }
    val settings = Settings(context)

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

    if (showSettings) SettingsDialog(initialUrl = settings.url ?: "", onDismiss = { showSettings = false }, onSave = { u, t -> showSettings = false; onSaveSettings(u, t) })
}

@Composable
private fun SettingsDialog(initialUrl: String, onDismiss: () -> Unit, onSave: (String, String) -> Unit) {
    var url by remember { mutableStateOf(initialUrl) }
    var token by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Gateway の設定") },
        text = {
            Column {
                OutlinedTextField(url, { url = it }, label = { Text("接続先 (ws://100.x.x.x:8787)") }, singleLine = true)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    token, { token = it }, label = { Text("トークン") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
            }
        },
        confirmButton = { TextButton(onClick = { onSave(url, token) }, enabled = url.isNotBlank() && token.isNotBlank()) { Text("保存して接続") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}
