package ai.magnetgate.client

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable
fun SettingsScreen(keySet: Boolean, pending: Boolean, notice: String, busy: Boolean, reports: Boolean,
  reportsWaiting: Int, onOpen: (Screen) -> Unit, onReports: (Boolean) -> Unit, onReconnect: () -> Unit,
) {
  val ui = LocalUiStrings.current
  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
    Text(ui.text(R.string.nav_settings), style = MaterialTheme.typography.headlineSmall)
    if (notice.isNotBlank()) InfoNotice(notice)
    Column {
      SectionLabel(ui.text(R.string.nav_connection))
      ActionRow(ui.text(R.string.nav_access), if (keySet) ui.text(R.string.key_saved) else ui.text(R.string.add_shared_key)) { onOpen(Screen.ACCESS) }
      ActionRow(ui.text(R.string.server_discovery), ui.text(R.string.discovery_summary)) { onOpen(Screen.ACCESS) }
      HorizontalDivider()
      ActionRow(ui.text(R.string.diagnostics_action), icon = R.drawable.ic_activity) { onOpen(Screen.DIAGNOSTICS) }
    }
    Column {
      SectionLabel(ui.text(R.string.privacy_section))
      // Отправка включена по умолчанию, поэтому строка обязана сказать, что именно уходит, до того
      // как человек до неё дотронется: молча включённая отправка - это не согласие.
      SwitchRow(ui.text(R.string.reports_title), ui.text(R.string.reports_detail), reports, onReports)
      Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(ui.text(R.string.reports_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
          if (!reports) ui.text(R.string.reports_off_hint)
          else if (reportsWaiting > 0) ui.text(R.string.reports_waiting, reportsWaiting)
          else ui.text(R.string.reports_on_hint),
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }
    Text(ui.text(R.string.system_theme_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (pending) {
      InfoNotice(ui.text(R.string.settings_reconnect_hint))
      BottomAction(ui.text(R.string.reconnect_apply), enabled = !busy, onClick = onReconnect)
    }
  }
}

@Composable
fun AccessScreen(psk: String, bootstrap: String, relays: String, slots: String, busy: Boolean, notice: String,
  storeFailure: String?, onPsk: (String) -> Unit, onBootstrap: (String) -> Unit, onRelays: (String) -> Unit,
  onSlots: (String) -> Unit, onSave: () -> Unit,
) {
  val ui = LocalUiStrings.current
  var advanced by rememberSaveable { mutableStateOf(false) }
  var validation by remember { mutableIntStateOf(0) }
  Column(Modifier.fillMaxSize().imePadding()) {
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
      Text(ui.text(R.string.group_key_title), style = MaterialTheme.typography.headlineSmall)
      Text(ui.text(R.string.group_key_hint), style = MaterialTheme.typography.bodyMedium)
      OutlinedTextField(psk, onPsk, label = { Text(ui.text(R.string.shared_key)) }, visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth())
      ActionRow(ui.text(R.string.discovery_options), if (advanced) ui.text(R.string.hide_advanced) else ui.text(R.string.discovery_summary)) { advanced = !advanced }
      if (advanced) {
        OutlinedTextField(bootstrap, onBootstrap, label = { Text("DHT bootstrap") }, supportingText = { Text(ui.text(R.string.bootstrap_hint)) }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(relays, onRelays, label = { Text(ui.text(R.string.nostr_relays)) }, supportingText = { Text(ui.text(R.string.relays_hint)) }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(slots, onSlots, label = { Text(ui.text(R.string.slots)) }, supportingText = { Text(ui.text(R.string.slot_hint, Settings.MAX_SLOTS - 1)) }, modifier = Modifier.fillMaxWidth())
      }
      if (validation != 0) InfoNotice(ui.text(validation), true)
      if (notice.isNotBlank()) InfoNotice(notice)
      if (storeFailure != null) InfoNotice(ui.text(R.string.storage_unavailable), true)
    }
    Column(Modifier.padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(ui.text(R.string.access_reconnect_hint), style = MaterialTheme.typography.bodySmall)
      BottomAction(ui.text(R.string.save_access), enabled = !busy && storeFailure == null) {
        val tokens = slots.split(',', ' ', '\n').filter { it.isNotBlank() }
        validation = when {
          psk.isBlank() -> R.string.key_required
          tokens.isEmpty() || tokens.any { it.toIntOrNull() !in 0 until Settings.MAX_SLOTS } -> R.string.slots_invalid
          bootstrap.isBlank() && relays.isBlank() -> R.string.channel_required
          else -> 0
        }
        if (validation == 0) onSave()
      }
    }
  }
}
