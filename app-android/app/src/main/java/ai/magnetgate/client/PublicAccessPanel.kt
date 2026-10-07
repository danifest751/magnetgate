package ai.magnetgate.client

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun PublicAccessPanel() {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  var code by remember { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }
  var message by remember { mutableStateOf("") }
  var enabled by remember { mutableStateOf(PublicAccess.enabled(context)) }
  Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
    Text("Личный доступ MagnetGate", style = MaterialTheme.typography.titleMedium)
    Text("Получите бесплатный код на magnet.norma.so. Сайты, видео и звонки — через ваши личные данные подключения.", style = MaterialTheme.typography.bodySmall)
    OutlinedTextField(code, { if (it.length <= 68) code = it.trim() }, label = { Text("Личный код MG1-…") }, singleLine = true,
      visualTransformation = PasswordVisualTransformation(), enabled = !busy, modifier = Modifier.fillMaxWidth())
    Button(enabled = !busy && code.isNotBlank(), onClick = {
      if (MgVpnService.hasInstance()) { message = "Сначала отключите VPN."; return@Button }
      scope.launch {
        busy = true; message = "Проверяем код…"
        runCatching { withContext(Dispatchers.IO) { PublicAccess.activate(context, code) } }
          .onSuccess { code = ""; enabled = true; message = "Готово. Вернитесь на экран «Связь» и нажмите «Подключить»." }
          .onFailure { message = it.message?.take(240) ?: "Не удалось подключить доступ." }
        busy = false
      }
    }) { Text(if (busy) "Подключаем…" else "Подключить личный доступ") }
    if (enabled) TextButton(enabled = !busy, onClick = {
      if (MgVpnService.hasInstance()) message = "Сначала отключите VPN."
      else runCatching { PublicAccess.clear(context); enabled = false; message = "Включён обычный режим серверов." }
        .onFailure { message = "Не удалось сохранить настройки." }
    }) { Text("Отключить личный доступ") }
    if (message.isNotBlank()) Text(message, style = MaterialTheme.typography.bodySmall)
    HorizontalDivider()
  }
}
