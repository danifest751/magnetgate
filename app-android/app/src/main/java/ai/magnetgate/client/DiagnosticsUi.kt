package ai.magnetgate.client

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

/**
 * The build a person is holding: the number Android compares when it is offered an update, and the
 * commit it was built from.
 *
 * Read from the package manager rather than from BuildConfig, because what matters is what is
 * installed - a debug build left on a phone beside a release is exactly the confusion this answers.
 */
private fun appBuild(context: android.content.Context): String = runCatching {
  val info = context.packageManager.getPackageInfo(context.packageName, 0)
  val code = if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
  "$code · ${info.versionName}"
}.getOrDefault("unknown")

@Composable
fun DiagnosticsScreen(status: CoreStatus, vpnUp: Boolean, check: Health.Check?, presentation: ConnectionPresentation,
  engineError: String, checking: Boolean, notice: String, onTest: () -> Unit,
) {
  val ui = LocalUiStrings.current
  val context = LocalContext.current
  var nodesOpen by rememberSaveable { mutableStateOf(false) }
  var liveOpen by rememberSaveable { mutableStateOf(false) }
  var logOpen by rememberSaveable { mutableStateOf(false) }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
    item { StatusPanel(presentation) }
    if (notice.isNotBlank()) item { InfoNotice(notice) }
    item {
      ValueRow(ui.text(R.string.vpn_interface), if (vpnUp) ui.text(R.string.running) else ui.text(R.string.off))
      ValueRow(ui.text(R.string.tunnel_check), if (!vpnUp) ui.text(R.string.no_tunnel) else check?.let { if (it.ok) ui.text(R.string.response_at, ui.clockOf(it.atMs)) else ui.text(R.string.no_response_at, ui.clockOf(it.atMs)) } ?: ui.text(R.string.not_checked))
      ValueRow(ui.text(R.string.tunnel_latency), check?.takeIf { vpnUp && it.ok }?.legs?.pingMs?.let { ui.text(R.string.milliseconds, it) } ?: ui.text(R.string.not_measured))
      ValueRow(ui.text(R.string.https_request), check?.takeIf { vpnUp }?.let { ui.durationOf(it.tookMs) } ?: ui.text(R.string.not_measured))
      ValueRow(ui.text(R.string.last_check_ip), check?.takeIf { vpnUp && it.ok }?.detail ?: ui.text(R.string.not_confirmed))
      Text(ui.text(R.string.check_scope_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    item { BottomAction(if (checking) ui.text(R.string.checking_action) else ui.text(R.string.check_again), enabled = vpnUp && !checking, secondary = true, onClick = onTest) }
    if (engineError.isNotBlank()) item { InfoNotice(engineError, true) }
    if (status.error.isNotBlank()) item { InfoNotice(status.error, true) }
    if (check != null && !check.ok && vpnUp) item { InfoNotice(check.detail, true) }
    item {
      HorizontalDivider()
      ActionRow(ui.text(R.string.servers_transports), ui.text(R.string.server_relay_count, status.nodes.size, status.relays.count { it.answering }, status.relays.size)) { nodesOpen = !nodesOpen }
    }
    if (nodesOpen) {
      if (status.nodes.isEmpty()) item { Text(ui.text(R.string.servers_empty)) }
      items(status.nodes, key = { "${it.slot}:${it.name}" }) { node ->
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
          Text(node.title, style = MaterialTheme.typography.titleMedium)
          Text(ui.text(R.string.country_slot, ui.countryName(node.country), node.slot), style = MaterialTheme.typography.bodySmall)
          node.planes.forEach { plane -> ValueRow(plane.type, plane.endpoint.ifBlank { ui.text(R.string.address_missing) }) }
          node.paused.filter { it.remainingMs(System.currentTimeMillis()) > 0 }.forEach { pause ->
            InfoNotice(ui.text(R.string.transport_pause, pause.type, ui.text(if (pause.slow) R.string.transport_slow else R.string.transport_failed), pause.remainingMs(System.currentTimeMillis()) / 1000))
          }
          HorizontalDivider()
        }
      }
      item { SectionLabel(ui.text(R.string.discovery_relays)) }
      items(status.relays, key = { it.url }) { relay ->
        ValueRow(relay.host, when { relay.answering -> ui.text(R.string.responses_received); relay.error.isNotEmpty() -> relay.error; relay.connected -> ui.text(R.string.connected_no_responses); else -> ui.text(R.string.not_connected) })
      }
      item {
        SectionLabel(ui.text(R.string.core_measurements))
        // Which build is this? The first question asked about any bug, and until now the screen could
        // not answer it: the core's version is a constant, and the app's was 1 for every build ever
        // made. This one names the commit, and says so when the tree it was built from was dirty.
        ValueRow(ui.text(R.string.app_build), appBuild(LocalContext.current))
        ValueRow(ui.text(R.string.core_version), status.version.ifBlank { ui.text(R.string.unknown) })
        ValueRow("SOCKS", if (status.socksPort > 0) "127.0.0.1:${status.socksPort}" else ui.text(R.string.not_running))
        ValueRow(ui.text(R.string.slots), status.slots.joinToString(", ").ifBlank { ui.text(R.string.none) })
        ValueRow(ui.text(R.string.rule_generation), RuleSets.generation(context).toString())
        ValueRow(ui.text(R.string.sent_received), "${ui.bytes(status.sent)} / ${ui.bytes(status.received)}")
        check?.takeIf { vpnUp }?.legs?.let {
          ValueRow(ui.text(R.string.connection_timings), ui.text(R.string.request_timings, it.connectMs, it.tlsMs, it.answerMs))
        }
      }
    }
    item {
      HorizontalDivider()
      ActionRow(ui.text(R.string.connections), ui.text(R.string.connection_counts, status.live.count { it.open }, status.live.size)) { liveOpen = !liveOpen }
    }
    if (liveOpen) {
      if (status.live.isEmpty()) item { Text(ui.text(R.string.connections_empty), style = MaterialTheme.typography.bodySmall) }
      items(status.live.take(20)) { live -> ValueRow(live.where, ui.text(R.string.connection_detail, ui.text(if (live.open) R.string.connection_open else R.string.connection_closed), live.plane, live.slot, ui.bytes(live.sent), ui.bytes(live.received))) }
    }
    item { HorizontalDivider(); ActionRow(ui.text(R.string.core_log), ui.text(R.string.core_log_hint)) { logOpen = !logOpen } }
    if (logOpen) {
      if (status.logs.isEmpty()) item { Text(ui.text(R.string.log_empty)) }
      items(status.logs) { line -> Text(line, style = MaterialTheme.typography.bodySmall, fontFamily = Mono) }
    }
  }
}
