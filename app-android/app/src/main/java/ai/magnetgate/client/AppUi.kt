package ai.magnetgate.client

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.VpnService
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import ai.magnetgate.core.mgbox.Mgbox
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL

private const val TAG = "magnetgate"

/** How often the screens re-read what the core and the service report. */
private const val REFRESH_MS = 1500L

// A public echo service is the only way to see the egress address from the device; a run against a
// hermetic stand overrides it, because such a stand has no route to the internet at all.
private const val DEFAULT_CHECK_URL = "https://api.ipify.org"

private enum class Screen(val label: String) {
  CONNECT("Connect"),
  SETTINGS("Settings"),
  DIAGNOSTICS("Diagnostics"),
}

/**
 * The whole UI: three screens over the two things the app owns - the core (through the binding) and the
 * tunnel (through [MgVpnService]).
 *
 * The screens are views over the same state, so the state lives here and is re-read from the core on a
 * timer instead of being pushed: the core's status document is cheap, and one reader cannot disagree with
 * another about what is running.
 *
 * The `autotest` path is the same code the buttons call, so a script can drive it without touching the
 * screen; see scripts/android/app-core-check.ps1.
 */
@Composable
fun AppRoot(
  autotest: Boolean,
  vpn: Boolean,
  coreless: Boolean,
  bootstrapExtra: String,
  relaysExtra: String,
  // Where the egress check goes. A hermetic stand has no internet, so a run against one points this
  // at its own target (http://10.0.2.2:<port>/) instead of a public echo service.
  checkUrlExtra: String = "",
  // Acceptance runs pick the routing mode on the command line; the screen still writes the store.
  modeExtra: String = "",
) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()

  var screen by remember { mutableStateOf(Screen.CONNECT) }
  var status by remember { mutableStateOf(CoreStatus()) }
  var vpnUp by remember { mutableStateOf(MgVpnService.isRunning()) }
  var busy by remember { mutableStateOf(false) }
  var egress by remember { mutableStateOf("") }
  var notice by remember { mutableStateOf("") }

  // Settings are read once and written by the settings screen; the connect path uses the stored values,
  // and the launch extras only exist so the acceptance scripts can point a run at another stand.
  var psk by remember { mutableStateOf(Settings.psk(context)) }
  var bootstrap by remember { mutableStateOf(Settings.bootstrap(context)) }
  var relays by remember { mutableStateOf(Settings.relays(context)) }
  var slots by remember { mutableStateOf(Settings.slots(context).joinToString(",")) }
  var excluded by remember { mutableStateOf(Settings.excluded(context).toSet()) }
  var mode by remember { mutableStateOf(Settings.mode(context)) }
  var directDomains by remember { mutableStateOf(Settings.directDomains(context).joinToString("\n")) }
  var tunnelDomains by remember { mutableStateOf(Settings.tunnelDomains(context).joinToString("\n")) }

  val wantedBootstrap = bootstrapExtra.ifBlank { bootstrap }
  val wantedRelays = relaysExtra.ifBlank { relays }

  LaunchedEffect(Unit) {
    while (true) {
      status = runCatching { CoreStatus.parse(Mgbox.coreStatus()) }
        .getOrElse { CoreStatus(error = it.message.orEmpty()) }
      vpnUp = MgVpnService.isRunning()
      delay(REFRESH_MS)
    }
  }

  val vpnConsent = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    if (result.resultCode == Activity.RESULT_OK) {
      startVpn(context, wantedBootstrap, wantedRelays, coreless, modeExtra)
    } else {
      notice = "the VPN consent was refused"
      Log.w(TAG, "the user refused the VPN consent")
    }
  }

  suspend fun startCore(): Int {
    busy = true
    val port = bringCoreUp(psk, slots, wantedBootstrap, wantedRelays)
    status = runCatching { CoreStatus.parse(Mgbox.coreStatus()) }.getOrDefault(status)
    busy = false
    return port
  }

  suspend fun checkEgress(port: Int) {
    if (port == 0) return
    busy = true
    val url = checkUrlExtra.ifBlank { DEFAULT_CHECK_URL }
    egress = runCatching { "egress ${fetchThroughCore(port, url)}" }
      .getOrElse { "egress check failed: ${it.message}" }
    busy = false
  }

  fun connect() {
    if (wantedBootstrap.isBlank() && wantedRelays.isBlank()) {
      notice = "no discovery channel: set a bootstrap node or a relay in Settings"
      return
    }
    val consent = VpnService.prepare(context)
    if (consent != null) vpnConsent.launch(consent) else startVpn(context, wantedBootstrap, wantedRelays, coreless, modeExtra)
  }

  if (autotest) {
    LaunchedEffect(Unit) {
      if (coreless) {
        // diagnostic path: the engine alone, with no second Go runtime in the process
        val consent = VpnService.prepare(context)
        if (consent != null) vpnConsent.launch(consent) else startVpn(context, wantedBootstrap, wantedRelays, true, modeExtra)
        recordAutotest(context, "coreless vpn-requested")
        return@LaunchedEffect
      }
      if (psk.isBlank()) {
        recordAutotest(context, "fail no-psk")
        return@LaunchedEffect
      }
      val port = startCore()
      if (port == 0) {
        recordAutotest(context, "fail start ${status.error}")
        return@LaunchedEffect
      }
      // give discovery a bounded chance, then use the tunnel the core offers
      var attempts = 0
      while (attempts < 40) {
        attempts++
        if (status.nodes.isNotEmpty()) break
        delay(1500)
        status = runCatching { CoreStatus.parse(Mgbox.coreStatus()) }.getOrDefault(status)
      }
      checkEgress(port)
      recordAutotest(context, "port=$port $egress")
      if (vpn) {
        // the consent dialog cannot be answered by a script, so a test run pre-grants the app-op; when
        // it was not granted, prepare() returns the intent and the tunnel simply does not come up
        val consent = VpnService.prepare(context)
        if (consent != null) {
          vpnConsent.launch(consent)
          Log.w(TAG, "AUTOTEST vpn=consent-required")
        } else {
          startVpn(context, wantedBootstrap, wantedRelays, coreless, modeExtra)
          Log.i(TAG, "AUTOTEST vpn=requested")
        }
      }
    }
  }

  // targetSdk 35 turns edge-to-edge on for every app, so the screen has to keep out of the system bars
  // itself or the tabs end up under the clock.
  Column(modifier = Modifier.fillMaxSize().systemBarsPadding()) {
    TabRow(selectedTabIndex = screen.ordinal) {
      for (item in Screen.entries) {
        Tab(
          selected = item == screen,
          onClick = {
            screen = item
            // a notice belongs to the screen that produced it
            notice = ""
          },
          text = { Text(item.label) },
        )
      }
    }
    when (screen) {
      Screen.CONNECT -> ConnectScreen(
        status = status,
        vpnUp = vpnUp,
        busy = busy,
        pskSet = psk.isNotBlank(),
        egress = egress,
        notice = notice,
        onConnect = { connect() },
        onDisconnect = { stopVpn(context); notice = "" },
        onTest = { scope.launch { checkEgress(status.socksPort) } },
        onOpenSettings = { screen = Screen.SETTINGS },
      )

      Screen.SETTINGS -> SettingsScreen(
        psk = psk,
        bootstrap = bootstrap,
        relays = relays,
        slots = slots,
        excluded = excluded,
        mode = mode,
        directDomains = directDomains,
        tunnelDomains = tunnelDomains,
        notice = notice,
        onPsk = { psk = it },
        onBootstrap = { bootstrap = it },
        onRelays = { relays = it },
        onSlots = { slots = it },
        onExcluded = { excluded = it },
        onMode = { mode = it },
        onDirectDomains = { directDomains = it },
        onTunnelDomains = { tunnelDomains = it },
        onSave = {
          Settings.setPsk(context, psk)
          Settings.setBootstrap(context, bootstrap)
          Settings.setRelays(context, relays)
          Settings.setSlots(context, Settings.parseSlots(slots))
          Settings.setExcluded(context, excluded)
          Settings.setMode(context, mode)
          Settings.setDirectDomains(context, directDomains)
          Settings.setTunnelDomains(context, tunnelDomains)
          slots = Settings.parseSlots(slots).joinToString(",")
          notice = "settings saved"
        },
        storeFailure = Settings.failureText(context),
        pskFromFile = Settings.pskFromFile(context),
      )

      Screen.DIAGNOSTICS -> DiagnosticsScreen(status = status, vpnUp = vpnUp)
    }
  }
}

/** The big button, the state it is in, and what was found. */
@Composable
private fun ConnectScreen(
  status: CoreStatus,
  vpnUp: Boolean,
  busy: Boolean,
  pskSet: Boolean,
  egress: String,
  notice: String,
  onConnect: () -> Unit,
  onDisconnect: () -> Unit,
  onTest: () -> Unit,
  onOpenSettings: () -> Unit,
) {
  Column(
    modifier = Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Text("MagnetGate", style = MaterialTheme.typography.headlineSmall)
    Text(status.headline(vpnUp), style = MaterialTheme.typography.titleMedium)

    if (!pskSet) {
      Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
          Text("No PSK yet", style = MaterialTheme.typography.titleSmall)
          Text("The client needs the shared key to find its exit.", style = MaterialTheme.typography.bodySmall)
          TextButton(onClick = onOpenSettings) { Text("Open settings") }
        }
      }
    }

    Button(
      onClick = { if (vpnUp) onDisconnect() else onConnect() },
      enabled = !busy && (vpnUp || pskSet),
      modifier = Modifier.fillMaxWidth(),
    ) { Text(if (vpnUp) "Disconnect" else "Connect") }

    if (egress.isNotEmpty()) Text(egress, style = MaterialTheme.typography.bodyMedium)
    if (notice.isNotEmpty()) Text(notice, style = MaterialTheme.typography.bodySmall)
    if (status.error.isNotEmpty()) Text("core: ${status.error}", style = MaterialTheme.typography.bodySmall)

    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
      TextButton(onClick = onTest, enabled = !busy && status.socksPort != 0) { Text("Test the exit") }
      Text("core ${status.version}", style = MaterialTheme.typography.bodySmall)
    }

    HorizontalDivider()
    Text("Nodes", style = MaterialTheme.typography.titleMedium)
    if (status.nodes.isEmpty()) {
      Text(
        if (vpnUp) "None yet - discovery takes a few seconds." else "Not connected.",
        style = MaterialTheme.typography.bodySmall,
      )
    }
    for (node in status.nodes) NodeCard(node)
  }
}

@Composable
private fun NodeCard(node: NodeRow) {
  Card(modifier = Modifier.fillMaxWidth()) {
    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (node.flag.isNotEmpty()) Text(node.flag, style = MaterialTheme.typography.titleLarge)
        Column {
          Text(node.title, style = MaterialTheme.typography.titleSmall)
          Text(
            listOfNotNull(
              node.country.takeIf { it.isNotBlank() },
              "slot ${node.slot}",
            ).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall,
          )
        }
      }
      Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (plane in node.planes) {
          Chip(plane.type, muted = node.paused.any { it.type == plane.type })
        }
      }
      for (pause in node.paused) {
        val seconds = (pause.remainingMs(System.currentTimeMillis()) / 1000).toInt()
        Text(
          "${pause.type} is paused for ${seconds}s after ${pause.fails} failure(s)",
          style = MaterialTheme.typography.bodySmall,
        )
      }
    }
  }
}

@Composable
private fun Chip(text: String, muted: Boolean = false) {
  Surface(
    color = if (muted) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.secondaryContainer,
    shape = MaterialTheme.shapes.small,
  ) {
    Box(modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp)) {
      Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSecondaryContainer,
      )
    }
  }
}

/**
 * Everything the user can change. The PSK is the only secret, and it goes into the encrypted store; the
 * rest is configuration the core reads at start.
 */
@Composable
private fun SettingsScreen(
  psk: String,
  bootstrap: String,
  relays: String,
  slots: String,
  excluded: Set<String>,
  mode: Settings.Mode,
  directDomains: String,
  tunnelDomains: String,
  notice: String,
  onPsk: (String) -> Unit,
  onBootstrap: (String) -> Unit,
  onRelays: (String) -> Unit,
  onSlots: (String) -> Unit,
  onExcluded: (Set<String>) -> Unit,
  onMode: (Settings.Mode) -> Unit,
  onDirectDomains: (String) -> Unit,
  onTunnelDomains: (String) -> Unit,
  onSave: () -> Unit,
  storeFailure: String?,
  pskFromFile: Boolean,
) {
  val apps = rememberLauncherApps()
  Column(
    modifier = Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()).imePadding(),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Text("Connection", style = MaterialTheme.typography.titleMedium)
    OutlinedTextField(
      value = psk,
      onValueChange = onPsk,
      label = { Text("PSK") },
      singleLine = true,
      visualTransformation = PasswordVisualTransformation(),
      modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
      value = bootstrap,
      onValueChange = onBootstrap,
      label = { Text("DHT bootstrap (host:port, comma separated)") },
      singleLine = true,
      modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
      value = relays,
      onValueChange = onRelays,
      label = { Text("Nostr relays (wss://..., comma separated)") },
      singleLine = true,
      modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
      value = slots,
      onValueChange = onSlots,
      label = { Text("Slots (comma separated)") },
      singleLine = true,
      modifier = Modifier.fillMaxWidth(),
    )

    Text("Routing", style = MaterialTheme.typography.titleMedium)
    Text(
      when (mode) {
        Settings.Mode.FULL ->
          "Everything goes through the tunnel. Only the domains listed below stay outside it."
        Settings.Mode.SPLIT ->
          "Only the blocked lists and the domains listed below go through the tunnel; the rest goes direct."
      },
      style = MaterialTheme.typography.bodySmall,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      for (option in Settings.Mode.entries) {
        FilterChip(
          selected = mode == option,
          onClick = { onMode(option) },
          label = { Text(if (option == Settings.Mode.FULL) "Full" else "Split") },
        )
      }
    }
    if (mode == Settings.Mode.SPLIT) {
      OutlinedTextField(
        value = tunnelDomains,
        onValueChange = onTunnelDomains,
        label = { Text("Through the tunnel (one per line)") },
        modifier = Modifier.fillMaxWidth(),
      )
    } else {
      OutlinedTextField(
        value = directDomains,
        onValueChange = onDirectDomains,
        label = { Text("Outside the tunnel (one per line)") },
        modifier = Modifier.fillMaxWidth(),
      )
    }

    if (pskFromFile) {
      Text(
        "The PSK currently comes from files/psk.txt; saving moves it into the encrypted store.",
        style = MaterialTheme.typography.bodySmall,
      )
    }
    if (storeFailure != null) {
      Text(
        "The encrypted store is unavailable ($storeFailure): the PSK stays in files/psk.txt only.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
      )
    }

    Button(onClick = onSave, modifier = Modifier.fillMaxWidth()) { Text("Save") }
    if (notice.isNotEmpty()) Text(notice, style = MaterialTheme.typography.bodySmall)

    HorizontalDivider()
    Text("Excluded applications", style = MaterialTheme.typography.titleMedium)
    Text(
      "Their traffic stays outside the tunnel and uses the normal network.",
      style = MaterialTheme.typography.bodySmall,
    )
    if (apps.isEmpty()) Text("No launchable applications were found.", style = MaterialTheme.typography.bodySmall)
    for (app in apps) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(
          checked = app.packageName in excluded,
          onCheckedChange = { checked ->
            onExcluded(if (checked) excluded + app.packageName else excluded - app.packageName)
          },
        )
        Column {
          Text(app.label, style = MaterialTheme.typography.bodyMedium)
          Text(app.packageName, style = MaterialTheme.typography.bodySmall)
        }
      }
    }
  }
}

/** The state a bug report needs: the core's own view, plus the tail of its log. */
@Composable
private fun DiagnosticsScreen(status: CoreStatus, vpnUp: Boolean) {
  Column(
    modifier = Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Text("Core", style = MaterialTheme.typography.titleMedium)
    Text(
      listOf(
        "version ${status.version}",
        "running ${status.running}",
        "socks 127.0.0.1:${status.socksPort}",
        "slots ${status.slots}",
        "tunnel ${if (vpnUp) "up" else "off"}",
      ).joinToString("\n"),
      style = MaterialTheme.typography.bodySmall,
      fontFamily = FontFamily.Monospace,
    )
    if (status.error.isNotEmpty()) {
      Text("error: ${status.error}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    }

    HorizontalDivider()
    Text("Nodes", style = MaterialTheme.typography.titleMedium)
    if (status.nodes.isEmpty()) Text("none", style = MaterialTheme.typography.bodySmall)
    for (node in status.nodes) {
      val now = System.currentTimeMillis()
      Text(
        buildString {
          append("slot ${node.slot}  ${node.title}")
          if (node.country.isNotBlank()) append("  ${node.country}")
          append('\n')
          append("  planes: ")
          append(node.planes.joinToString(" ") { it.type + (if (it.endpoint.isEmpty()) "" else "@${it.endpoint}") })
          if (node.paused.isNotEmpty()) {
            append('\n')
            append("  paused: ")
            append(node.paused.joinToString(" ") { "${it.type}(${(it.remainingMs(now) / 1000).toInt()}s)" })
          }
        },
        style = MaterialTheme.typography.bodySmall,
        fontFamily = FontFamily.Monospace,
      )
    }

    HorizontalDivider()
    Text("Core log", style = MaterialTheme.typography.titleMedium)
    Text(
      status.logs.joinToString("\n"),
      style = MaterialTheme.typography.bodySmall,
      fontFamily = FontFamily.Monospace,
    )
  }
}

/** One row per launchable application, with the label the launcher shows. */
private data class AppEntry(val packageName: String, val label: String)

@Composable
private fun rememberLauncherApps(): List<AppEntry> {
  val context = LocalContext.current
  var apps by remember { mutableStateOf(emptyList<AppEntry>()) }
  LaunchedEffect(Unit) {
    apps = withContext(Dispatchers.IO) { launcherApps(context) }
  }
  return apps
}

/**
 * Launchable applications only, and only the ones the package manager will answer for without the
 * QUERY_ALL_PACKAGES permission: the launcher query is exactly the list a user can recognise.
 */
private fun launcherApps(context: Context): List<AppEntry> {
  val manager = context.packageManager
  val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
  return manager.queryIntentActivities(intent, 0)
    .mapNotNull { it.activityInfo?.applicationInfo }
    .distinctBy { it.packageName }
    .filter { it.packageName != context.packageName }
    .map { AppEntry(it.packageName, label(manager, it)) }
    .sortedBy { it.label.lowercase() }
}

private fun label(manager: android.content.pm.PackageManager, info: ApplicationInfo): String =
  runCatching { manager.getApplicationLabel(info).toString() }.getOrDefault(info.packageName)

/** Brings the core up with the given configuration and returns its SOCKS port, or 0 on failure. */
private suspend fun bringCoreUp(psk: String, slots: String, bootstrap: String, relays: String): Int =
  withContext(Dispatchers.IO) {
    runCatching {
      val port = Mgbox.startCore(
        CoreConfig.json(
          psk = psk,
          slots = Settings.parseSlots(slots),
          bootstrap = CoreConfig.splitList(bootstrap),
          relays = CoreConfig.splitList(relays),
        ),
      )
      Log.i(TAG, "core started, socks port $port")
      port.toInt()
    }.onFailure { Log.e(TAG, "core failed to start: ${it.message}") }.getOrDefault(0)
  }

/** Fetches a URL through the core's SOCKS listener: the app's own traffic through the tunnel. */
private suspend fun fetchThroughCore(port: Int, url: String): String = withContext(Dispatchers.IO) {
  val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", port))
  val connection = URL(url).openConnection(proxy) as HttpURLConnection
  connection.connectTimeout = 20_000
  connection.readTimeout = 20_000
  try {
    connection.inputStream.bufferedReader().use { it.readText().trim() }
  } finally {
    connection.disconnect()
  }
}

private fun recordAutotest(context: Context, text: String) {
  Log.i(TAG, "AUTOTEST $text")
  runCatching { File(context.filesDir, "autotest.txt").writeText(text) }
}

/** Hands the tunnel to the service, which owns the core and the engine while it runs. */
private fun startVpn(
  context: Context,
  bootstrap: String,
  relays: String,
  coreless: Boolean,
  // Empty means "use the stored setting"; an acceptance run overrides it without touching the store,
  // the same way it overrides the discovery channels.
  mode: String = "",
) {
  val intent = Intent(context, MgVpnService::class.java)
    .setAction(MgVpnService.ACTION_START)
    .putExtra("bootstrap", bootstrap)
    .putExtra("relays", relays)
    .putExtra("coreless", coreless)
    .putExtra("mode", mode)
  context.startForegroundService(intent)
}

private fun stopVpn(context: Context) {
  context.startService(Intent(context, MgVpnService::class.java).setAction(MgVpnService.ACTION_STOP))
}
