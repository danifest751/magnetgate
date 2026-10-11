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
    if (current.channels != null && ChannelWallet.available(context)) PayAsYouGo(current) { scope.launch { load() } }
  }
}

/** Pay as you go from the in-app wallet over a payment channel (PAYMENTS.md §4.2). */
@Composable
private fun PayAsYouGo(payment: PaymentInfo, reload: () -> Unit) {
  val context = LocalContext.current
  val ui = LocalUiStrings.current
  val scope = rememberCoroutineScope()
  val terms = payment.channels ?: return
  var exists by remember { mutableStateOf(ChannelWallet.exists(context)) }
  var status by remember { mutableStateOf<ChannelWallet.Status?>(null) }
  var pass by remember { mutableStateOf("") }
  var deposit by remember { mutableStateOf("1") }
  var busy by remember { mutableStateOf(false) }
  var message by remember { mutableStateOf("") }
  LaunchedEffect(exists, payment) {
    if (exists) status = withContext(Dispatchers.IO) { runCatching { ChannelWallet.status(context, payment) }.getOrNull() }
  }
  fun act(done: Int?, work: () -> Unit) {
    scope.launch {
      busy = true; message = ui.text(R.string.wallet_working)
      runCatching { withContext(Dispatchers.IO) { work() } }
        .onSuccess { message = done?.let { ui.text(it) } ?: ""; exists = ChannelWallet.exists(context); reload() }
        .onFailure { android.util.Log.w("MgWallet", "wallet action failed", it); message = it.message?.take(240) ?: ui.text(R.string.public_failed) }
      busy = false
    }
  }
  val export = androidx.activity.compose.rememberLauncherForActivityResult(
    androidx.activity.result.contract.ActivityResultContracts.CreateDocument("text/plain")) { uri ->
    if (uri != null) act(R.string.wallet_exported) { ChannelWallet.exportKey(context, uri) }
  }
  Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
    HorizontalDivider()
    Text(ui.text(R.string.wallet_title), style = MaterialTheme.typography.titleMedium)
    Text(ui.text(R.string.wallet_hint), style = MaterialTheme.typography.bodySmall)
    if (!exists) {
      OutlinedTextField(pass, { if (it.length <= 200) pass = it }, label = { Text(ui.text(R.string.wallet_pass_label)) }, singleLine = true,
        visualTransformation = PasswordVisualTransformation(), enabled = !busy, modifier = Modifier.fillMaxWidth())
      OutlinedButton(enabled = !busy, onClick = { act(null) { ChannelWallet.create(context, pass, payment); pass = "" } }) {
        Text(ui.text(R.string.wallet_create))
      }
    } else {
      val current = status
      if (current != null) {
        SelectionContainer { Text(current.address, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
        val balance = current.balance?.let { ui.text(R.string.wallet_balance, Payments.formatRqt(it)) } ?: ui.text(R.string.wallet_balance_unknown)
        Text(balance + " · " + ui.text(R.string.wallet_price, Payments.formatRqt(terms.pricePerMinute), Payments.formatRqt(terms.minDeposit)),
          style = MaterialTheme.typography.bodySmall)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          OutlinedButton(onClick = {
            context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("RQT", current.address))
          }) { Text(ui.text(R.string.payment_copy)) }
          OutlinedButton(enabled = !busy, onClick = { export.launch("magnetgate-requant-key.txt") }) { Text(ui.text(R.string.wallet_export)) }
        }
      }
      val ch = payment.channel
      val pending = ChannelWallet.pending(context) && ch?.status == "accepted"
      val live = ch != null && ch.status in listOf("accepted", "open") && !pending
      val text = when {
        pending -> ui.text(R.string.wallet_pending)
        ch == null || ch.status in listOf("dropped", "expired") -> ui.text(R.string.wallet_none)
        ch.status == "closed" -> ui.text(R.string.wallet_closed, Payments.formatRqt(ch.paid))
        ch.status == "abandoned" -> ui.text(R.string.wallet_unclosed)
        ch.status == "accepted" && ch.paid == 0L -> ui.text(R.string.wallet_waiting, Payments.formatRqt(ch.deposit), payment.confirmations)
        else -> ui.text(R.string.wallet_live, Payments.formatRqt(ch.deposit), Payments.formatRqt(ch.paid),
          (ch.deposit - ChannelWallet.FEE - ch.paid) / terms.pricePerMinute)
      }
      Text(text, style = MaterialTheme.typography.bodySmall)
      if (live) {
        OutlinedButton(enabled = !busy, onClick = { act(R.string.wallet_closing) { ChannelWallet.close(context) } }) { Text(ui.text(R.string.wallet_close)) }
      } else {
        if (ch?.status == "abandoned")
          OutlinedButton(enabled = !busy, onClick = { act(R.string.wallet_refunded) { ChannelWallet.refund(context, payment) } }) { Text(ui.text(R.string.wallet_refund)) }
        OutlinedTextField(deposit, { if (it.length <= 20) deposit = it }, label = { Text(ui.text(R.string.wallet_deposit_label)) }, singleLine = true,
          enabled = !busy, modifier = Modifier.fillMaxWidth())
        Button(enabled = !busy, onClick = {
          val atoms = Payments.parseRqt(deposit)
          if (atoms == null) message = ui.text(R.string.wallet_bad_amount)
          else act(R.string.wallet_opened) { ChannelWallet.open(context, payment, Settings.publicCode(context), atoms) }
        }) { Text(ui.text(R.string.wallet_open)) }
      }
    }
    if (message.isNotBlank()) Text(message, style = MaterialTheme.typography.bodySmall)
    if (exists && payment.swaps != null) BuyRqt(payment)
  }
}

private fun usdtText(units: Long) = java.math.BigDecimal.valueOf(units, 6).stripTrailingZeros().toPlainString()

/** Buying RQT from the service's maker over Lightning, on-chain Bitcoin or USDT on TRON (atomic swaps). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BuyRqt(payment: PaymentInfo) {
  val context = LocalContext.current
  val ui = LocalUiStrings.current
  val scope = rememberCoroutineScope()
  val terms = payment.swaps ?: return
  var amount by remember { mutableStateOf("1") }
  var method by remember { mutableStateOf(if (terms.lightning && "lightning" in terms.methods) "lightning" else "bitcoin") }
  var list by remember { mutableStateOf(ChannelWallet.swaps(context)) }
  var busy by remember { mutableStateOf(false) }
  var message by remember { mutableStateOf("") }
  // purchases move on by themselves while the panel is open
  LaunchedEffect(payment) {
    while (true) {
      list = withContext(Dispatchers.IO) { runCatching { ChannelWallet.advance(context, payment) }.getOrDefault(list) }
      kotlinx.coroutines.delay(10_000)
    }
  }
  val stateText = { s: String ->
    ui.text(when (s) {
      "waiting", "waiting_ln" -> R.string.swap_state_waiting
      "waiting_btc" -> R.string.swap_state_waiting_btc
      "rqt_locked" -> R.string.swap_state_locked
      "waiting_token" -> R.string.swap_state_waiting_usdt
      "locking" -> R.string.swap_state_locking
      "usdt_locked" -> R.string.swap_state_usdt_locked
      "claimed", "done" -> R.string.swap_state_done
      "expired" -> R.string.swap_state_expired
      "underpaid", "too_late" -> R.string.swap_state_refund
      "refunded" -> R.string.swap_state_refunded
      else -> R.string.swap_state_failed
    })
  }
  Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
    HorizontalDivider()
    Text(ui.text(R.string.swap_title), style = MaterialTheme.typography.titleMedium)
    Text(ui.text(R.string.swap_price, terms.satsPerRqt, Payments.formatRqt(terms.minAtoms), Payments.formatRqt(terms.maxAtoms)),
      style = MaterialTheme.typography.bodySmall)
    val usdt = terms.usdt?.takeIf { "usdt" in terms.methods }
    if (usdt != null) Text(ui.text(R.string.swap_price_usdt, usdtText(usdt.unitsPerRqt)), style = MaterialTheme.typography.bodySmall)
    OutlinedTextField(amount, { if (it.length <= 20) amount = it }, label = { Text(ui.text(R.string.swap_amount)) }, singleLine = true,
      enabled = !busy, modifier = Modifier.fillMaxWidth())
    // three ways to pay do not fit one line on a phone: the chips wrap
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      if (terms.lightning && "lightning" in terms.methods)
        FilterChip(selected = method == "lightning", onClick = { method = "lightning" }, label = { Text(ui.text(R.string.swap_lightning)) })
      if ("bitcoin" in terms.methods)
        FilterChip(selected = method == "bitcoin", onClick = { method = "bitcoin" }, label = { Text(ui.text(R.string.swap_bitcoin)) })
      if (usdt != null)
        FilterChip(selected = method == "usdt", onClick = { method = "usdt" }, label = { Text(ui.text(R.string.swap_usdt)) })
    }
    Button(enabled = !busy, onClick = {
      val atoms = Payments.parseRqt(amount)
      if (atoms == null) { message = ui.text(R.string.wallet_bad_amount); return@Button }
      scope.launch {
        busy = true; message = ui.text(R.string.wallet_working)
        runCatching { withContext(Dispatchers.IO) { ChannelWallet.buy(context, payment, method, atoms) } }
          .onSuccess { list = ChannelWallet.swaps(context); message = ui.text(R.string.swap_started) }
          .onFailure { android.util.Log.w("MgWallet", "buy failed", it); message = it.message?.take(240) ?: ui.text(R.string.public_failed) }
        busy = false
      }
    }) { Text(ui.text(R.string.swap_buy)) }
    for (s in list.reversed().take(5)) {
      val usdtState = when (s.state) {
        "expired" -> R.string.swap_usdt_state_expired
        "too_late", "failed", "rqt_refunded" -> R.string.swap_usdt_state_refund
        "refunded" -> R.string.swap_usdt_state_refunded
        else -> null
      }
      Text(Payments.formatRqt(s.rqtAtoms) + " RQT · " + (if (s.method == "usdt" && usdtState != null) ui.text(usdtState) else stateText(s.state)),
        style = MaterialTheme.typography.bodyMedium)
      if (!s.note.isNullOrBlank()) Text(s.note, style = MaterialTheme.typography.bodySmall)
      if (s.method == "usdt" && s.state in listOf("waiting", "waiting_token")) {
        val target = s.address ?: ""
        Text(ui.text(R.string.swap_pay_usdt, usdtText(s.usdtUnits), s.held ?: "0"), style = MaterialTheme.typography.bodySmall)
        SelectionContainer { Text(target, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
        OutlinedButton(onClick = {
          context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("pay", target))
        }) { Text(ui.text(R.string.payment_copy)) }
      }
      if (s.method != "usdt" && s.state in listOf("waiting", "waiting_ln", "waiting_btc")) {
        val target = s.invoice ?: s.address ?: ""
        Text(ui.text(if (s.invoice != null) R.string.swap_pay_ln else R.string.swap_pay_btc, s.sats), style = MaterialTheme.typography.bodySmall)
        SelectionContainer { Text(target, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          OutlinedButton(onClick = {
            context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("pay", target))
          }) { Text(ui.text(R.string.payment_copy)) }
          if (s.invoice != null) OutlinedButton(onClick = {
            runCatching {
              context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("lightning:" + s.invoice))
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
            }.onFailure { message = ui.text(R.string.swap_no_wallet) }
          }) { Text(ui.text(R.string.swap_open_wallet)) }
        }
      }
      val usdtBack = s.method == "usdt" && s.state in listOf("too_late", "expired", "failed", "rqt_refunded") &&
        (s.lock == "open" || (s.held?.toDoubleOrNull() ?: 0.0) > 0)
      if ((s.method == "bitcoin" && s.state in listOf("underpaid", "too_late", "expired")) || usdtBack) {
        var to by remember(s.file) { mutableStateOf("") }
        if (usdtBack && s.lock == "open" && s.refundFrom > 0)
          Text(ui.text(R.string.swap_refund_from, java.text.DateFormat.getDateTimeInstance().format(java.util.Date(s.refundFrom * 1000))),
            style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(to, { if (it.length <= 90) to = it.trim() },
          label = { Text(ui.text(if (usdtBack) R.string.swap_refund_to_tron else R.string.swap_refund_to)) }, singleLine = true,
          modifier = Modifier.fillMaxWidth())
        OutlinedButton(enabled = !busy, onClick = {
          scope.launch {
            busy = true
            runCatching { withContext(Dispatchers.IO) { ChannelWallet.refundSwap(context, payment, s.file, to) } }
              .onSuccess { list = ChannelWallet.swaps(context); message = ui.text(R.string.wallet_refunded) }
              .onFailure { message = it.message?.take(240) ?: ui.text(R.string.public_failed) }
            busy = false
          }
        }) { Text(ui.text(if (usdtBack) R.string.swap_refund_usdt else R.string.swap_refund)) }
      }
    }
    if (message.isNotBlank()) Text(message, style = MaterialTheme.typography.bodySmall)
  }
}
