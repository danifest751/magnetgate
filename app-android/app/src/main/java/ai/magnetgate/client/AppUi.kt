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
import androidx.compose.ui.unit.sp
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
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.Canvas
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp

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
  // Which tab to open on. `input tap` is refused on this ROM (trap 56), so a screenshot run has no other
  // way to see a screen that is not the first one.
  screenExtra: String = "",
  // How loudly the engine should log for this tunnel: a hunt asks for `debug`, everyday use does not.
  engineLogExtra: String = "",
  // An acceptance run's hook, carried through untouched: the service decides whether to honour it, and
  // only a debuggable build does (MgVpnService.brokenSlot).
  breakSlotExtra: String = "",
) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()

  var screen by remember {
    mutableStateOf(Screen.entries.firstOrNull { it.name.equals(screenExtra, ignoreCase = true) } ?: Screen.CONNECT)
  }
  var status by remember { mutableStateOf(CoreStatus()) }
  var vpnUp by remember { mutableStateOf(MgVpnService.isRunning()) }
  var busy by remember { mutableStateOf(false) }
  var egress by remember { mutableStateOf("") }
  var check by remember { mutableStateOf(Health.lastCheck) }
  var engineError by remember { mutableStateOf(Health.engineError) }
  var notice by remember { mutableStateOf("") }

  // Settings are read once and written by the settings screen; the connect path uses the stored values,
  // and the launch extras only exist so the acceptance scripts can point a run at another stand.
  var psk by remember { mutableStateOf(Settings.psk(context)) }
  var bootstrap by remember { mutableStateOf(Settings.bootstrap(context)) }
  var relays by remember { mutableStateOf(Settings.relays(context)) }
  var slots by remember { mutableStateOf(Settings.slots(context).joinToString(",")) }
  var excluded by remember { mutableStateOf(Settings.excluded(context).toSet()) }
  var mode by remember { mutableStateOf(Settings.mode(context)) }
  var country by remember { mutableStateOf(Settings.country(context)) }
  var apps by remember { mutableStateOf(Settings.apps(context)) }
  var directDomains by remember { mutableStateOf(Settings.directDomains(context).joinToString("\n")) }
  var tunnelDomains by remember { mutableStateOf(Settings.tunnelDomains(context).joinToString("\n")) }

  // `none` means "this channel is off for this run" and blank means "use the stored setting"; the
  // service resolves the extras the same way, so the screen and the tunnel never disagree about which
  // channels a run is allowed to use.
  val wantedBootstrap = Settings.channel(bootstrapExtra, bootstrap)
  val wantedRelays = Settings.channel(relaysExtra, relays)

  val vpnConsent = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    if (result.resultCode == Activity.RESULT_OK) {
      startVpn(context, bootstrapExtra, relaysExtra, coreless, modeExtra, engineLogExtra, breakSlotExtra)
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
    if (consent != null) vpnConsent.launch(consent) else startVpn(context, bootstrapExtra, relaysExtra, coreless, modeExtra, engineLogExtra, breakSlotExtra)
  }

  LaunchedEffect(Unit) {
    var wasUp = vpnUp
    while (true) {
      status = runCatching { CoreStatus.parse(Mgbox.coreStatus()) }
        .getOrElse { CoreStatus(error = it.message.orEmpty()) }
      vpnUp = MgVpnService.isRunning()
      // the service measures; the screen only reports what it found, so this keeps working with the
      // app closed and the reading is never older than the label next to it says
      check = Health.lastCheck
      engineError = Health.engineError
      // Check the egress once the tunnel is actually up, not before it. Without the engine the core
      // can only use its own native plane, and on a mobile network that port is often blocked - so a
      // check run first reports a failure for a tunnel that then works perfectly through reality.
      if (vpnUp && !wasUp) {
        egress = ""
        if (status.socksPort != 0) checkEgress(status.socksPort)
      }
      if (!vpnUp && wasUp) egress = ""
      wasUp = vpnUp
      delay(REFRESH_MS)
    }
  }

  if (autotest) {
    LaunchedEffect(Unit) {
      if (coreless) {
        // diagnostic path: the engine alone, with no second Go runtime in the process
        val consent = VpnService.prepare(context)
        if (consent != null) vpnConsent.launch(consent) else startVpn(context, bootstrapExtra, relaysExtra, true, modeExtra, engineLogExtra, breakSlotExtra)
        recordAutotest(context, "coreless vpn-requested")
        return@LaunchedEffect
      }
      if (psk.isBlank()) {
        recordAutotest(context, "fail no-psk")
        return@LaunchedEffect
      }
      // The core has exactly one owner. When a tunnel is asked for it is the service: it starts the core
      // itself, waits for a node and hands the engine that port. A second Start from here replaces the
      // core and leaves the engine dialling a port nothing is listening on - the tun stays up, the node
      // list stays healthy, and not a byte moves. Measured on 17.09: the service's core was on 41485 and
      // the screen replaced it with 38639 two tenths of a second later.
      if (!vpn) {
        val started = startCore()
        if (started == 0) {
          recordAutotest(context, "fail start ${status.error}")
          return@LaunchedEffect
        }
        // give discovery a bounded chance; with a tunnel the service does this waiting itself
        var attempts = 0
        while (attempts < 40) {
          attempts++
          if (status.nodes.isNotEmpty()) break
          delay(1500)
          status = runCatching { CoreStatus.parse(Mgbox.coreStatus()) }.getOrDefault(status)
        }
      }
      // When a tunnel is asked for, bring it up BEFORE measuring the egress. Without the engine the
      // core can only use its own native plane, and on a mobile network that port is often blocked -
      // measuring first then reports a failure for a tunnel that works perfectly through reality.
      if (vpn) {
        // the consent dialog cannot be answered by a script, so a test run pre-grants the app-op; when
        // it was not granted, prepare() returns the intent and the tunnel simply does not come up
        val consent = VpnService.prepare(context)
        if (consent != null) {
          vpnConsent.launch(consent)
          Log.w(TAG, "AUTOTEST vpn=consent-required")
        } else {
          startVpn(context, bootstrapExtra, relaysExtra, coreless, modeExtra, engineLogExtra, breakSlotExtra)
          Log.i(TAG, "AUTOTEST vpn=requested")
          var waited = 0
          while (waited < 60 && !MgVpnService.isRunning()) {
            waited++
            delay(1000)
          }
          Log.i(TAG, "AUTOTEST vpn=${if (MgVpnService.isRunning()) "up after ${waited}s" else "not up"}")
          status = runCatching { CoreStatus.parse(Mgbox.coreStatus()) }.getOrDefault(status)
        }
      }
      // The status document is the live truth about where the core listens, whoever started it.
      status = runCatching { CoreStatus.parse(Mgbox.coreStatus()) }.getOrDefault(status)
      val live = status.socksPort
      if (live == 0) {
        recordAutotest(context, "fail no-core ${status.error}")
        return@LaunchedEffect
      }
      checkEgress(live)
      recordAutotest(context, "port=$live $egress")
    }
  }

  // targetSdk 35 turns edge-to-edge on for every app, so the screen has to keep out of the system bars
  // itself or the tabs end up under the clock.
  Column(modifier = Modifier.fillMaxSize().systemBarsPadding()) {
    // The product name sits here rather than inside the first screen: it belongs to the window, not to
    // one tab, and the tab that is open should be the first thing under it.
    Row(
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 8.dp),
    ) {
      ProductMark(size = 34.dp)
      Text("MagnetGate", style = MaterialTheme.typography.headlineSmall)
    }
    TabRow(
      selectedTabIndex = screen.ordinal,
      containerColor = MaterialTheme.colorScheme.background,
      contentColor = MaterialTheme.colorScheme.onBackground,
    ) {
      for (item in Screen.entries) {
        Tab(
          selected = item == screen,
          onClick = {
            screen = item
            // a notice belongs to the screen that produced it
            notice = ""
          },
          // One line at every width, and sized so the longest label fits inside its third of the row:
          // "Diagnostics" used to break across two lines and drag the whole row down with it.
          text = {
            Text(
              item.label,
              style = MaterialTheme.typography.labelLarge.copy(fontSize = 12.sp, letterSpacing = 0.sp),
              maxLines = 1,
              softWrap = false,
            )
          },
        )
      }
    }
    Spacer(Modifier.height(12.dp))
    when (screen) {
      Screen.CONNECT -> ConnectScreen(
        status = status,
        vpnUp = vpnUp,
        busy = busy,
        pskSet = psk.isNotBlank(),
        egress = egress,
        check = check,
        engineError = engineError,
        notice = notice,
        country = country,
        onCountry = { code ->
          country = code
          Settings.setCountry(context, code)
          // The core is told at once rather than at the next connect: the nodes are discovered and the
          // planes are wired, so this changes only which of them the next stream prefers.
          runCatching { Mgbox.setCountry(code) }
            .onFailure { Log.w(TAG, "the country preference did not reach the core: ${it.message}") }
        },
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
        appsMode = apps,
        mode = mode,
        directDomains = directDomains,
        tunnelDomains = tunnelDomains,
        notice = notice,
        onPsk = { psk = it },
        onBootstrap = { bootstrap = it },
        onRelays = { relays = it },
        onSlots = { slots = it },
        onExcluded = { excluded = it },
        onAppsMode = { apps = it },
        onMode = { mode = it },
        onDirectDomains = { directDomains = it },
        onTunnelDomains = { tunnelDomains = it },
        onSave = {
          Settings.setPsk(context, psk)
          Settings.setBootstrap(context, bootstrap)
          Settings.setRelays(context, relays)
          Settings.setSlots(context, Settings.parseSlots(slots))
          Settings.setExcluded(context, excluded)
          Settings.setApps(context, apps)
          Settings.setMode(context, mode)
          Settings.setDirectDomains(context, directDomains)
          Settings.setTunnelDomains(context, tunnelDomains)
          slots = Settings.parseSlots(slots).joinToString(",")
          notice = "settings saved"
        },
        storeFailure = Settings.failureText(context),
        pskFromFile = Settings.pskFromFile(context),
      )

      Screen.DIAGNOSTICS -> DiagnosticsScreen(status = status, vpnUp = vpnUp, check = check)
    }
  }
}

/** How well the tunnel is doing, in the only grades that change what a person should do next. */
private enum class Grade { OFF, OK, WARN, BAD }

private fun gradeOf(status: CoreStatus, vpnUp: Boolean, check: Health.Check?, engineError: String): Grade = when {
  !vpnUp -> Grade.OFF
  status.error.isNotEmpty() || engineError.isNotEmpty() -> Grade.BAD
  !status.running -> Grade.BAD
  check != null && !check.ok -> Grade.BAD
  status.nodes.isEmpty() -> Grade.WARN
  check != null && check.slow -> Grade.WARN
  status.relaysConfiguredButSilent -> Grade.WARN
  check == null -> Grade.WARN
  else -> Grade.OK
}

/**
 * The screen someone opens to answer one question: is my traffic going where I think it is?
 *
 * So the answer comes first and in colour, the thing they came to press comes second, and the evidence -
 * which exit answered, how long it took, what carries it - comes third, in the face measurements are set
 * in. The exits are a list, not a stack of cards: they are the same kind of thing repeated, and giving
 * each one its own raised surface flattens the hierarchy instead of building one.
 */
@Composable
private fun ConnectScreen(
  status: CoreStatus,
  vpnUp: Boolean,
  busy: Boolean,
  pskSet: Boolean,
  egress: String,
  check: Health.Check?,
  engineError: String,
  notice: String,
  country: String,
  onCountry: (String) -> Unit,
  onConnect: () -> Unit,
  onDisconnect: () -> Unit,
  onTest: () -> Unit,
  onOpenSettings: () -> Unit,
) {
  val grade = gradeOf(status, vpnUp, check, engineError)
  Column(
    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Spacer(Modifier.height(4.dp))
    StateBand(headline = status.headline(vpnUp, check), grade = grade, check = check, vpnUp = vpnUp)

    Button(
      onClick = { if (vpnUp) onDisconnect() else onConnect() },
      enabled = !busy && (vpnUp || pskSet),
      shape = RoundedCornerShape(12.dp),
      modifier = Modifier.fillMaxWidth().height(52.dp),
    ) {
      Text(if (vpnUp) "Disconnect" else "Connect", style = MaterialTheme.typography.titleMedium)
    }

    if (!pskSet) {
      Notice(
        title = "No key yet",
        body = "This client needs the shared key before it can find an exit.",
        grade = Grade.WARN,
        action = "Open settings" to onOpenSettings,
      )
    }
    if (notice.isNotEmpty()) Notice(title = notice)

    val complaints = complaintsOf(status, check, engineError)
    if (complaints.isNotEmpty()) {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (line in complaints) Complaint(line.first, line.second)
      }
    }

    // The country control lives on the Connect screen rather than in Settings because it is a thing
    // people change while looking at where their traffic is going, and because it needs no reconnect:
    // the core applies it to the next stream. It appears only when there is a choice to make.
    if (status.countries.size > 1) {
      SectionLabel("Country")
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(
          selected = country.isEmpty(),
          onClick = { onCountry("") },
          label = { Text("Any") },
        )
        for (row in status.countries) {
          FilterChip(
            selected = country == row.code,
            onClick = { onCountry(row.code) },
            label = { Text("${row.flag} ${row.code}" + if (row.nodes > 1) "  ${row.nodes}" else "") },
          )
        }
      }
      // A preference that cannot be honoured right now is honoured as far as it can be, and said out
      // loud: refusing to carry traffic because a country is momentarily gone would be the worse answer.
      if (country.isNotEmpty() && status.nodes.none { it.country.equals(country, ignoreCase = true) }) {
        Text(
          "No node in $country right now - traffic leaves through the others until one returns.",
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }

    if (vpnUp || status.socksPort != 0) {
      SectionLabel("Route")
      Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        ValueRow("Exit", egress.removePrefix("egress ").ifBlank { "not measured" })
        ValueRow("Round trip", check?.legs?.pingMs?.let { "${it}ms" } ?: "not measured")
        ValueRow("Whole request", check?.let { clockOf(it.atMs) + "  " + lastWord(it.summary()) } ?: "not yet")
        // Where that time went. The total is one number for four round trips over three legs, and
        // which leg grew is the only part of it anyone can act on.
        check?.legs?.let { ValueRow("Spent on", it.summary()) }
        ValueRow("Planes", carriedBy(status))
        // Counters, because "connected" and "carrying something" are different claims and this screen
        // has been wrong about the difference before. They count every byte the core carried, which is
        // every byte the tunnel carried: the engine routes all of it through the core.
        ValueRow("Carried", "${bytes(status.sent)} out · ${bytes(status.received)} in")
        ValueRow("Core", status.version)
      }
      TextButton(
        onClick = onTest,
        enabled = !busy && status.socksPort != 0,
        contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp),
      ) { Text("Measure the exit now", style = MaterialTheme.typography.labelLarge) }
    }

    SectionLabel("Exits")
    if (status.nodes.isEmpty()) {
      Text(
        if (vpnUp) "None yet - discovery takes a few seconds." else "Nothing discovered while the tunnel is off.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
      for (node in status.nodes) NodeRowView(node)
    }
    Spacer(Modifier.height(24.dp))
  }
}

/**
 * A byte count a person can read at a glance.
 *
 * Powers of two and one decimal, in Locale.US like every other measurement here, so that a reading can
 * be compared with a log line rather than being a different number on a different phone.
 */
private fun bytes(value: Long): String {
  if (value < 1024) return "$value B"
  val units = listOf("KB", "MB", "GB", "TB")
  var scaled = value.toDouble() / 1024
  var unit = 0
  while (scaled >= 1024 && unit < units.lastIndex) {
    scaled /= 1024
    unit++
  }
  return String.format(java.util.Locale.US, "%.1f %s", scaled, units[unit])
}

/** The tail of a summary, which is where its measurement sits ("... in 788ms"). */
private fun lastWord(text: String): String = text.substringAfterLast(' ')

/** What the exit list amounts to in one line: four planes over two exits, or nothing at all. */
private fun carriedBy(status: CoreStatus): String {
  if (status.nodes.isEmpty()) return "nothing yet"
  val planes = status.nodes.sumOf { node -> node.planes.count { it.type == "reality" || it.type == "hy2" } }
  val exits = status.nodes.size
  return "$planes plane${if (planes == 1) "" else "s"} over $exits exit${if (exits == 1) "" else "s"}"
}

/**
 * The answer, in colour, with the measurement that backs it.
 *
 * "Connected" on its own is what this screen said through the DNS regress of 17.09 while pages were
 * barely loading, so the band carries the reading as well as the word - and takes its colour from
 * whether that reading is good, rather than from whether the tunnel is merely up.
 */
@Composable
private fun StateBand(headline: String, grade: Grade, check: Health.Check?, vpnUp: Boolean) {
  val state = LocalStateColors.current
  val ink = when (grade) {
    Grade.OFF -> MaterialTheme.colorScheme.onSurfaceVariant
    Grade.OK -> state.ok
    Grade.WARN -> state.warn
    Grade.BAD -> state.bad
  }
  val ground = when (grade) {
    Grade.OFF -> MaterialTheme.colorScheme.surfaceVariant
    Grade.OK -> state.okSurface
    Grade.WARN -> state.warnSurface
    Grade.BAD -> state.badSurface
  }
  Column(
    modifier = Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(14.dp))
      .background(ground)
      .padding(horizontal = 16.dp, vertical = 14.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      Box(modifier = Modifier.size(10.dp).clip(CircleShape).background(ink))
      Text(headline, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurface)
    }
    Text(
      when {
        !vpnUp -> "Traffic is leaving this phone the ordinary way."
        check == null -> "The exit has not been measured yet."
        // The round trip, not the whole request. The band used to carry the total - four round trips,
        // two handshakes and a resolver - which is half a second on a perfectly healthy phone and reads
        // like a ping to anyone who glances at it. The total still exists; it moved down to the
        // measurements, where a number is expected to need reading.
        check.ok && check.legs?.pingMs != null ->
          "The exit answers in " + check.legs.pingMs + "ms, measured at " + clockOf(check.atMs) + "."
        check.ok -> "A full HTTPS request through the tunnel took " + lastWord(check.summary()) +
          " at " + clockOf(check.atMs) + "."
        else -> "Last measurement at " + clockOf(check.atMs) + ": " + check.detail + "."
      },
      style = MaterialTheme.typography.bodySmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}

/** Everything the app knows that a person should act on, and nothing it merely knows. */
private fun complaintsOf(
  status: CoreStatus,
  check: Health.Check?,
  engineError: String,
): List<Pair<String, Grade>> = buildList {
  if (engineError.isNotEmpty()) add(engineError.replaceFirstChar { it.uppercase() } to Grade.BAD)
  if (check != null && !check.ok) add(("The exit did not answer: " + check.detail) to Grade.BAD)
  if (check != null && check.slow) add(("Slow: the exit took " + lastWord(check.summary()) + " to answer") to Grade.WARN)
  if (status.relaysConfiguredButSilent) {
    add("No relay is answering - hy2 and routing-list updates travel that channel and cannot arrive" to Grade.WARN)
  }
  if (status.error.isNotEmpty()) add(("Core: " + status.error) to Grade.BAD)
}

@Composable
private fun Complaint(text: String, grade: Grade) {
  val state = LocalStateColors.current
  val ink = if (grade == Grade.WARN) state.warn else state.bad
  Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
    Box(modifier = Modifier.padding(top = 6.dp).size(6.dp).clip(CircleShape).background(ink))
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
  }
}

/** A short, quiet block for something the person may want to do next. */
@Composable
private fun Notice(
  title: String,
  body: String = "",
  grade: Grade = Grade.OK,
  action: Pair<String, () -> Unit>? = null,
) {
  val state = LocalStateColors.current
  val ink = when (grade) {
    Grade.BAD -> state.bad
    Grade.WARN -> state.warn
    else -> MaterialTheme.colorScheme.onSurfaceVariant
  }
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(10.dp))
      .background(MaterialTheme.colorScheme.surfaceVariant)
      .padding(horizontal = 14.dp, vertical = 12.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Box(modifier = Modifier.padding(top = 5.dp).size(8.dp).clip(CircleShape).background(ink))
    Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.weight(1f)) {
      Text(title, style = MaterialTheme.typography.titleSmall)
      if (body.isNotEmpty()) {
        Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      if (action != null) {
        TextButton(
          onClick = action.second,
          contentPadding = PaddingValues(horizontal = 0.dp, vertical = 2.dp),
        ) { Text(action.first, style = MaterialTheme.typography.labelLarge) }
      }
    }
  }
}

/**
 * The product mark: a horseshoe magnet standing as a gate, with the way through laid across its poles.
 *
 * The same drawing as the launcher icon, and drawn here rather than loaded from that vector so it takes
 * its two colours from the theme: the magnet in the text ink of whichever theme is on, the bar in the
 * accent the app spends on its one control. A two-colour vector would have to hard-code both, and would
 * be wrong in one of the two themes.
 */
@Composable
private fun ProductMark(size: Dp = 34.dp) {
  val gate = MaterialTheme.colorScheme.onBackground
  val path = MaterialTheme.colorScheme.primary
  Canvas(modifier = Modifier.size(size)) {
    // The launcher drawing carries a wide margin, because an adaptive icon has to survive any mask. In
    // the header there is no mask and no margin worth keeping, so the same geometry is mapped by its own
    // bounding box instead of by the 108-unit canvas: the mark then stands as tall as the word beside it.
    val unit = this.size.minDimension / 63f
    val dx = (this.size.width - 59f * unit) / 2f - 24.5f * unit
    val dy = (this.size.height - 63f * unit) / 2f - 22.5f * unit
    fun px(value: Float) = dx + value * unit
    fun py(value: Float) = dy + value * unit
    val stroke = 11f * unit

    // the magnet, standing as a gate: one continuous stroke, poles down
    val magnet = Path().apply {
      moveTo(px(30f), py(80f))
      lineTo(px(30f), py(52f))
      arcTo(
        rect = Rect(left = px(30f), top = py(28f), right = px(78f), bottom = py(76f)),
        startAngleDegrees = 180f,
        sweepAngleDegrees = 180f,
        forceMoveTo = false,
      )
      lineTo(px(78f), py(80f))
    }
    drawPath(magnet, color = gate, style = Stroke(width = stroke, cap = StrokeCap.Round, join = StrokeJoin.Round))

    // the way through, laid across its poles
    drawLine(
      color = path,
      start = Offset(px(30f), py(66f)),
      end = Offset(px(78f), py(66f)),
      strokeWidth = 9f * unit,
      cap = StrokeCap.Round,
    )
  }
}

/** A section marker, not a sentence: small, spaced, and set apart from the values under it. */
@Composable
private fun SectionLabel(text: String) {
  Text(
    text.uppercase(),
    style = MaterialTheme.typography.labelMedium,
    color = MaterialTheme.colorScheme.onSurfaceVariant,
    modifier = Modifier.padding(top = 4.dp),
  )
}

/** A measured thing and its measurement, the value in the face measurements are set in. */
@Composable
private fun ValueRow(label: String, value: String) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.Top,
  ) {
    Text(
      label,
      style = MaterialTheme.typography.bodySmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      maxLines = 1,
      modifier = Modifier.width(84.dp),
    )
    // a size down from the prose around it: a monospace face at the same size runs half again as wide,
    // and a value that wraps stops lining up with the one above it
    Text(
      value,
      style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 17.sp),
      fontFamily = Mono,
      color = MaterialTheme.colorScheme.onSurface,
      modifier = Modifier.weight(1f),
    )
  }
}

/** Wall-clock time of a measurement: "when did it last work" is the question being answered. */
private fun clockOf(atMs: Long): String =
  java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date(atMs))

/**
 * One exit, as a row rather than a card.
 *
 * The rail down the left is the state of that exit - green while every plane is usable, amber while one
 * is merely demoted, red while one is paused after failing - so a list of exits can be read without
 * reading any of it.
 */
@Composable
private fun NodeRowView(node: NodeRow) {
  val state = LocalStateColors.current
  val paused = node.paused.filterNot { it.slow }
  val slow = node.paused.filter { it.slow }
  val rail = when {
    paused.isNotEmpty() -> state.bad
    slow.isNotEmpty() -> state.warn
    else -> state.ok
  }
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(10.dp))
      .background(MaterialTheme.colorScheme.surface)
      .height(IntrinsicSize.Min),
  ) {
    Box(modifier = Modifier.width(3.dp).fillMaxHeight().background(rail))
    Column(
      modifier = Modifier.weight(1f).padding(horizontal = 14.dp, vertical = 12.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (node.flag.isNotEmpty()) Text(node.flag, style = MaterialTheme.typography.titleMedium)
        Text(node.title, style = MaterialTheme.typography.titleSmall)
        Text(
          listOfNotNull(node.country.takeIf { it.isNotBlank() }, "slot " + node.slot).joinToString("  "),
          style = MaterialTheme.typography.labelSmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
      Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (plane in node.planes) {
          val pause = node.paused.firstOrNull { it.type == plane.type }
          PlaneChip(plane.type, pause?.slow == true, pause != null)
        }
      }
      for (pause in node.paused) {
        val seconds = (pause.remainingMs(System.currentTimeMillis()) / 1000).toInt()
        Text(
          if (pause.slow) pause.type + " answers slowly - others go first for " + seconds + "s"
          else pause.type + " paused for " + seconds + "s after " + pause.fails + " failure(s)",
          style = MaterialTheme.typography.labelSmall,
          color = if (pause.slow) state.warn else state.bad,
        )
      }
    }
  }
}

/**
 * One transport an exit offers. A plane that is sitting out says so in its own colour: the difference
 * between "this path is broken" and "this path is merely slow" is the difference between a tunnel that
 * needs attention and one that is quietly working around something.
 */
@Composable
private fun PlaneChip(text: String, slow: Boolean, sittingOut: Boolean) {
  val state = LocalStateColors.current
  val ink = when {
    !sittingOut -> MaterialTheme.colorScheme.onSurfaceVariant
    slow -> state.warn
    else -> state.bad
  }
  Box(
    modifier = Modifier
      .clip(RoundedCornerShape(6.dp))
      .border(1.dp, if (sittingOut) ink.copy(alpha = 0.5f) else state.rule, RoundedCornerShape(6.dp))
      .padding(horizontal = 8.dp, vertical = 3.dp),
  ) {
    Text(text, style = MaterialTheme.typography.labelSmall, color = ink)
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
  appsMode: Settings.Apps,
  mode: Settings.Mode,
  directDomains: String,
  tunnelDomains: String,
  notice: String,
  onPsk: (String) -> Unit,
  onBootstrap: (String) -> Unit,
  onRelays: (String) -> Unit,
  onSlots: (String) -> Unit,
  onExcluded: (Set<String>) -> Unit,
  onAppsMode: (Settings.Apps) -> Unit,
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

    SectionLabel("Routing")
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
    Text("Applications", style = MaterialTheme.typography.titleMedium)
    // The same list, read two ways. "Everything but these" is what this client has always done; "only
    // these" is the phone that tunnels one messenger and leaves banking and local services alone.
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      FilterChip(
        selected = appsMode == Settings.Apps.EXCEPT,
        onClick = { onAppsMode(Settings.Apps.EXCEPT) },
        label = { Text("Everything but these") },
      )
      FilterChip(
        selected = appsMode == Settings.Apps.ONLY,
        onClick = { onAppsMode(Settings.Apps.ONLY) },
        label = { Text("Only these") },
      )
    }
    Text(
      if (appsMode == Settings.Apps.ONLY) {
        "Only the applications ticked below go through the tunnel; everything else uses the normal " +
          "network. Tick nothing and the tunnel carries everything, because a tunnel for no application " +
          "at all is never what an empty list meant."
      } else {
        "Their traffic stays outside the tunnel and uses the normal network."
      },
      style = MaterialTheme.typography.bodySmall,
    )
    Text(
      "A change here needs a reconnect: the list is handed to the system when the tunnel is built.",
      style = MaterialTheme.typography.bodySmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
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
/**
 * Everything the app knows, in the order someone debugging asks for it: what the core is, what it
 * found, whether the push channel is answering, when the path was last measured, and then the log.
 *
 * It is a readout, so it is set as one: labels apart from values, values in the monospace face, and
 * colour spent only where a line means something is wrong.
 */
@Composable
private fun DiagnosticsScreen(status: CoreStatus, vpnUp: Boolean, check: Health.Check?) {
  val state = LocalStateColors.current
  Column(
    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Spacer(Modifier.height(4.dp))
    SectionLabel("Core")
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
      ValueRow("Version", status.version.ifBlank { "unknown" })
      ValueRow("Running", if (status.running) "yes" else "no")
      ValueRow("Socks", "127.0.0.1:" + status.socksPort)
      ValueRow("Slots", status.slots.joinToString(", ").ifBlank { "none" })
      ValueRow("Tunnel", if (vpnUp) "up" else "off")
      // 0 means the lists are still the ones the package shipped with; anything else is the generation a
      // node published and this device verified by digest.
      ValueRow("Rule-sets", "generation " + RuleSets.generation(LocalContext.current))
    }
    if (status.error.isNotEmpty()) Complaint("Core: " + status.error, Grade.BAD)

    SectionLabel("Exits")
    if (status.nodes.isEmpty()) {
      Text("none", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    for (node in status.nodes) {
      val now = System.currentTimeMillis()
      Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        ValueRow(
          "slot " + node.slot,
          listOfNotNull(node.title, node.country.takeIf { it.isNotBlank() }).joinToString("  "),
        )
        ValueRow("planes", node.planes.joinToString("  ") { it.type + (if (it.endpoint.isEmpty()) "" else "@" + it.endpoint) })
        if (node.paused.isNotEmpty()) {
          ValueRow(
            "sitting out",
            node.paused.joinToString("  ") {
              it.type + "(" + (it.remainingMs(now) / 1000).toInt() + "s " + (if (it.slow) "slow" else it.fails.toString() + "f") + ")"
            },
          )
        }
      }
    }

    SectionLabel("Rendezvous relays")
    if (status.relays.isEmpty()) {
      Text(
        "None configured - discovery is DHT only, so hy2 and rule-set updates cannot arrive.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    for (relay in status.relays) {
      Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
      ) {
        // "connected, silent" is the state that looked healthy for a day; it must not look healthy here
        Box(
          modifier = Modifier
            .padding(top = 5.dp)
            .size(7.dp)
            .clip(CircleShape)
            .background(if (relay.answering) state.ok else state.bad),
        )
        Column(modifier = Modifier.weight(1f)) {
          Text(relay.host, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp), fontFamily = Mono)
          Text(
            relay.state,
            style = MaterialTheme.typography.labelSmall,
            color = if (relay.answering) MaterialTheme.colorScheme.onSurfaceVariant else state.bad,
          )
        }
      }
    }

    SectionLabel("Exit checks")
    Text(
      check?.let { clockOf(it.atMs) + "  " + it.summary() } ?: "not run yet",
      style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
      fontFamily = Mono,
      color = when {
        check == null -> MaterialTheme.colorScheme.onSurfaceVariant
        !check.ok -> state.bad
        check.slow -> state.warn
        else -> MaterialTheme.colorScheme.onSurface
      },
    )

    SectionLabel("Core log")
    Box(
      modifier = Modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(10.dp))
        .background(MaterialTheme.colorScheme.surface)
        .padding(12.dp),
    ) {
      Text(
        status.logs.joinToString("\n").ifBlank { "empty - the core keeps its log only while it runs" },
        style = MaterialTheme.typography.labelSmall,
        fontFamily = Mono,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    Spacer(Modifier.height(24.dp))
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
    // the service owns the core whenever it is starting or running; starting a second one would replace
    // it and strand the engine on a dead port
    if (MgVpnService.ownsCore()) {
      Log.i(TAG, "the service owns the core; not starting another")
      return@withContext runCatching { CoreStatus.parse(Mgbox.coreStatus()).socksPort }.getOrDefault(0)
    }
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

/**
 * Hands the tunnel to the service, which owns the core and the engine while it runs.
 *
 * The discovery arguments are passed exactly as they arrived in the launch extras - blank, a value, or
 * [Settings.CHANNEL_OFF] - and the service resolves them against the store. Resolving them here as well
 * would turn "this channel is off" back into "", which the service reads as "use the stored setting".
 */
private fun startVpn(
  context: Context,
  bootstrap: String,
  relays: String,
  coreless: Boolean,
  // Empty means "use the stored setting"; an acceptance run overrides it without touching the store,
  // the same way it overrides the discovery channels.
  mode: String = "",
  engineLog: String = "",
  breakSlot: String = "",
) {
  val intent = Intent(context, MgVpnService::class.java)
    .setAction(MgVpnService.ACTION_START)
    .putExtra("bootstrap", bootstrap)
    .putExtra("relays", relays)
    .putExtra("coreless", coreless)
    .putExtra("mode", mode)
    .putExtra("enginelog", engineLog)
    .putExtra("breakslot", breakSlot)
  context.startForegroundService(intent)
}

private fun stopVpn(context: Context) {
  context.startService(Intent(context, MgVpnService::class.java).setAction(MgVpnService.ACTION_STOP))
}
