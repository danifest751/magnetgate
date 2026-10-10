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
  val ui = LocalUiStrings.current
  val scope = rememberCoroutineScope()
  var code by remember { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }
  var message by remember { mutableStateOf("") }
  var enabled by remember { mutableStateOf(PublicAccess.enabled(context)) }
  Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
    Text(ui.text(R.string.public_title), style = MaterialTheme.typography.titleMedium)
    Text(ui.text(R.string.public_hint), style = MaterialTheme.typography.bodySmall)
    OutlinedTextField(code, { if (it.length <= 68) code = it.trim() }, label = { Text(ui.text(R.string.public_code_label)) }, singleLine = true,
      visualTransformation = PasswordVisualTransformation(), enabled = !busy, modifier = Modifier.fillMaxWidth())
    Button(enabled = !busy && code.isNotBlank(), onClick = {
      if (MgVpnService.hasInstance()) { message = ui.text(R.string.public_vpn_first); return@Button }
      scope.launch {
        busy = true; message = ui.text(R.string.public_checking)
        runCatching { withContext(Dispatchers.IO) { PublicAccess.activate(context, code) } }
          .onSuccess { code = ""; enabled = true; message = ui.text(R.string.public_done) }
          .onFailure { message = it.message?.take(240) ?: ui.text(R.string.public_failed) }
        busy = false
      }
    }) { Text(ui.text(if (busy) R.string.public_connecting else R.string.public_activate)) }
    if (enabled) TextButton(enabled = !busy, onClick = {
      if (MgVpnService.hasInstance()) message = ui.text(R.string.public_vpn_first)
      else runCatching { PublicAccess.clear(context); enabled = false; message = ui.text(R.string.public_servers_mode) }
        .onFailure { message = ui.text(R.string.public_save_failed) }
    }) { Text(ui.text(R.string.public_deactivate)) }
    if (message.isNotBlank()) Text(message, style = MaterialTheme.typography.bodySmall)
    HorizontalDivider()
  }
}
