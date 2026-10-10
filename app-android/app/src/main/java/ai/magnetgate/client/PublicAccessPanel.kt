package ai.magnetgate.client

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
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
    if (enabled) PaymentBlock()
    HorizontalDivider()
  }
}

/** Full access paid in RQT: shown only when the access service takes payments (PAYMENTS.md §1a). */
@Composable
private fun PaymentBlock() {
  val context = LocalContext.current
  val ui = LocalUiStrings.current
  val scope = rememberCoroutineScope()
  var info by remember { mutableStateOf<PaymentInfo?>(null) }
  var checking by remember { mutableStateOf(false) }
  suspend fun load() {
    checking = true
    // no payments there, or the service is unreachable: nothing to show
    info = withContext(Dispatchers.IO) { runCatching { PublicAccess.payment(context) }.getOrNull() }
    checking = false
  }
  LaunchedEffect(Unit) { load() }
  val current = info ?: return
  val date = { seconds: Long -> java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM, ui.locale).format(java.util.Date(seconds * 1000)) }
  Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
    HorizontalDivider()
    Text(ui.text(R.string.payment_title), style = MaterialTheme.typography.titleMedium)
    val status = if (current.fullNow()) ui.text(R.string.payment_full_until, date(current.paidUntil)) else ui.text(R.string.payment_free)
    val network = if (current.network == "main") "" else " · " + ui.text(R.string.payment_test_network)
    Text(status + " · " + ui.text(R.string.payment_code_expires, date(current.expires)) + network, style = MaterialTheme.typography.bodySmall)
    Text(ui.text(R.string.payment_hint), style = MaterialTheme.typography.bodySmall)
    SelectionContainer { Text(current.address, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      OutlinedButton(onClick = {
        context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("RQT", current.address))
      }) { Text(ui.text(R.string.payment_copy)) }
      OutlinedButton(enabled = !checking, onClick = { scope.launch { load() } }) { Text(ui.text(R.string.payment_check)) }
    }
    for (step in current.steps()) {
      val amount = Payments.formatRqt(step.atoms)
      Text("• " + if (step.off > 0) ui.text(R.string.payment_price_off, step.days, amount, step.off) else ui.text(R.string.payment_price, step.days, amount),
        style = MaterialTheme.typography.bodyMedium)
    }
    if (current.balance > 0) Text(ui.text(R.string.payment_balance, Payments.formatRqt(current.balance)), style = MaterialTheme.typography.bodySmall)
    Text(ui.text(R.string.payment_note, current.confirmations, current.confirmations), style = MaterialTheme.typography.bodySmall)
  }
}
