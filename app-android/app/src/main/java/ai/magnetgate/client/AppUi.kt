package ai.magnetgate.client

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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
private const val REFRESH_MS = 1500L
private const val DEFAULT_CHECK_URL = "https://api.ipify.org"

private val RoutingSaver = listSaver<RoutingDraft, String>(
  save = { listOf(it.mode.stored, it.apps.stored, it.packages.joinToString("\n"), it.direct.joinToString("\n"), it.tunnel.joinToString("\n")) },
  restore = { RoutingDraft(Settings.Mode.of(it[0]), Settings.Apps.of(it[1]), it[2].lines().filter(String::isNotBlank).toSet(), it[3].lines().filter(String::isNotBlank), it[4].lines().filter(String::isNotBlank)) },
)

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
  val ui = LocalUiStrings.current
  val context = LocalContext.current
  val scope = rememberCoroutineScope()

  var screen by rememberSaveable {
    mutableStateOf(Screen.entries.firstOrNull { it.name.equals(screenExtra, ignoreCase = true) } ?: Screen.CONNECT)
  }
  var status by remember { mutableStateOf(CoreStatus()) }
  var vpnUp by remember { mutableStateOf(MgVpnService.isRunning()) }
  var busy by remember { mutableStateOf(false) }
  var egress by remember { mutableStateOf("") }
  var check by remember { mutableStateOf(Health.lastCheck) }
  var engineError by remember { mutableStateOf(Health.engineError) }
  var notice by remember { mutableIntStateOf(0) }

  // Settings are read once and written by the settings screen; the connect path uses the stored values,
  // and the launch extras only exist so the acceptance scripts can point a run at another stand.
  var psk by remember { mutableStateOf(Settings.psk(context)) }
  var bootstrap by remember { mutableStateOf(Settings.bootstrap(context)) }
  var relays by remember { mutableStateOf(Settings.relays(context)) }
  var slots by remember { mutableStateOf(Settings.slots(context).joinToString(",")) }
  var country by remember { mutableStateOf(Settings.country(context)) }
  // What the update card is saying right now: empty while nothing is happening, which is almost always.
  var updateState by remember { mutableStateOf("") }
  var savedRules by remember { mutableStateOf(RoutingDraft.read(context)) }
  var rules by rememberSaveable(stateSaver = RoutingSaver) { mutableStateOf(savedRules) }
  var starting by remember { mutableStateOf(MgVpnService.isStarting()) }
  var revision by remember { mutableStateOf(Settings.revision(context)) }
  var appliedRevision by remember { mutableStateOf(MgVpnService.appliedSettingsRevision()) }
  var activeRules by remember { mutableStateOf(MgVpnService.appliedRouting()) }
  var now by remember { mutableStateOf(System.currentTimeMillis()) }
  var checkingSince by remember { mutableStateOf(0L) }
  var parentScreen by rememberSaveable { mutableStateOf(Screen.CONNECT) }
  // Отчёты о сбоях: состояние переключателя и сколько отчётов ждёт туннеля. Читается при открытии
  // настроек, а не раз за жизнь экрана, - отчёт мог быть записан или отправлен уже после запуска.
  // One tap, one installer session: see the comment at the call site.
  var installing by remember { mutableStateOf(false) }
  var reports by remember { mutableStateOf(Reports.enabled(context)) }
  var reportsWaiting by remember { mutableIntStateOf(Reports.pending(context).size) }
  val pending = vpnUp && revision != appliedRevision

  fun open(next: Screen) {
    if (next in listOf(Screen.DIAGNOSTICS, Screen.ACCESS, Screen.COUNTRIES)) parentScreen = screen
    if (next == Screen.SETTINGS) {
      reports = Reports.enabled(context)
      reportsWaiting = Reports.pending(context).size
    }
    screen = next
    notice = 0
  }

  fun back() {
    screen = if (screen in listOf(Screen.CONNECT, Screen.RULES, Screen.SETTINGS)) Screen.CONNECT else parentScreen
    notice = 0
  }
  BackHandler(enabled = screen != Screen.CONNECT) { back() }

  // `none` means "this channel is off for this run" and blank means "use the stored setting"; the
  // service resolves the extras the same way, so the screen and the tunnel never disagree about which
  // channels a run is allowed to use.
  val wantedBootstrap = Settings.channel(bootstrapExtra, bootstrap)
  val wantedRelays = Settings.channel(relaysExtra, relays)

  val vpnConsent = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    if (result.resultCode == Activity.RESULT_OK) {
      startVpn(context, bootstrapExtra, relaysExtra, coreless, modeExtra, engineLogExtra, breakSlotExtra)
    } else {
      notice = R.string.vpn_consent_denied
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

  /**
   * Fetch the offered build and hand it to the system installer.
   *
   * It goes through the core's own listener, so it needs the tunnel: on the network this client exists
   * for, the place a release is published is usually what is unreachable. Nothing is installed here -
   * the package is verified against the sealed manifest and then given to Android, which checks the
   * signature and asks the person.
   */
  fun takeUpdate() {
    val offered = Updates.offered(context, status.update)
    if (offered == null) {
      // Every refusal says why. A screen that does nothing when tapped, and a log with nothing in it,
      // is how this project has lost hours before: absence of an error is not absence of a problem.
      Log.i(TAG, "update: nothing worth offering (installed ${Updates.installedCode(context)})")
      return
    }
    if (!Updates.mayInstall(context)) {
      updateState = ui.text(R.string.update_needs_permission)
      Log.w(TAG, "update: this phone has not allowed this app to install packages; asking")
      runCatching { context.startActivity(Updates.permissionIntent(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
      return
    }
    // Already downloaded and checked? Then this tap is the install, and it happens with the screen in
    // front of the person - which is the only way Android will raise its dialog at all.
    if (Updates.stagedBuild(context) == offered.versionCode) {
      val apk = java.io.File(context.filesDir, "update.apk")
      updateState = ui.text(R.string.update_verified)
      Updates.withdrawAnnouncement(context)
      // One tap, one session. On 20.09 the dialog never appeared, the owner tapped again, and each tap
      // wrote the whole package into a new session and committed it: four sessions in a second and a
      // half. The dialog is now raised from here, where this activity is on screen and allowed to.
      if (installing) return
      installing = true
      scope.launch {
        val handed = withContext(Dispatchers.IO) {
          Updates.install(context, apk) { confirm ->
            scope.launch(Dispatchers.Main) {
              val activity = context as? android.app.Activity
              runCatching {
                if (activity != null) activity.startActivity(confirm)
                else context.startActivity(confirm.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
              }.onFailure {
                Log.w(TAG, "showing the install dialog: ${it.message}")
                updateState = ui.text(R.string.update_install_now)
              }
              installing = false
            }
          }
        }
        if (!handed) {
          installing = false
          updateState = ui.text(R.string.update_install_now)
        }
      }
      return
    }
    val port = status.socksPort
    if (!vpnUp || port == 0) {
      updateState = ui.text(R.string.update_needs_tunnel)
      Log.w(TAG, "update: no tunnel to fetch it through (vpnUp=$vpnUp, core port $port)")
      return
    }
    busy = true
    scope.launch {
      val apk = withContext(Dispatchers.IO) {
        Updates.download(context, offered, port) { progress ->
          updateState = when (progress) {
            is Updates.Progress.Downloading ->
              ui.text(R.string.update_downloading, (progress.bytes * 100 / progress.total.coerceAtLeast(1)).toInt())
            is Updates.Progress.Failed -> ui.text(R.string.update_failed, progress.why)
            Updates.Progress.Verified -> ui.text(R.string.update_verified)
          }
        }
      }
      busy = false
      if (apk != null) {
        // The download took minutes and the person has probably moved on, so the system would abort a
        // dialog raised from here. The package waits; the shade and the card both say it is ready.
        Updates.announce(context, offered)
        updateState = ui.text(R.string.update_install_now)
      }
    }
  }

  fun connect() {
    if (Settings.psk(context).isBlank()) { open(Screen.ACCESS); return }
    if (Settings.channel(bootstrapExtra, Settings.bootstrap(context)).isBlank() && Settings.channel(relaysExtra, Settings.relays(context)).isBlank()) {
      notice = R.string.discovery_required
      return
    }
    val consent = VpnService.prepare(context)
    if (consent != null) vpnConsent.launch(consent) else startVpn(context, bootstrapExtra, relaysExtra, coreless, modeExtra, engineLogExtra, breakSlotExtra)
  }

  LaunchedEffect(Unit) {
    while (true) {
      status = withContext(Dispatchers.IO) { runCatching { CoreStatus.parse(Mgbox.coreStatus()) }.getOrElse { CoreStatus(error = it.message.orEmpty()) } }
      vpnUp = MgVpnService.isRunning()
      starting = MgVpnService.isStarting()
      check = Health.lastCheck
      engineError = Health.engineError
      revision = Settings.revision(context)
      appliedRevision = MgVpnService.appliedSettingsRevision()
      activeRules = MgVpnService.appliedRouting()
      now = System.currentTimeMillis()
      if (checkingSince != 0L && (check?.atMs ?: 0L) > checkingSince) checkingSince = 0L
      if (checkingSince != 0L && now - checkingSince > 60_000) {
        checkingSince = 0L
        notice = R.string.check_timeout
      }
      delay(REFRESH_MS)
    }
  }

  fun reconnect() {
    if (busy || starting) return
    scope.launch {
      busy = true
      try {
        stopVpn(context)
        val deadline = System.currentTimeMillis() + 15_000
        while (MgVpnService.hasInstance() && System.currentTimeMillis() < deadline) delay(250)
        if (MgVpnService.hasInstance()) notice = R.string.vpn_still_stopping
        else { vpnUp = false; check = null; connect() }
      } finally { busy = false }
    }
  }

  fun saveRules() {
    if (busy || starting) return
    val draft = rules
    scope.launch {
      busy = true
      val ok = withContext(Dispatchers.IO) { runCatching { Settings.saveRouting(context, draft) }.getOrDefault(false) }
      if (ok) { savedRules = draft; revision = Settings.revision(context); notice = R.string.rules_saved }
      else notice = R.string.rules_save_failed
      busy = false
    }
  }

  fun saveAccess() {
    if (busy || starting) return
    scope.launch {
      busy = true
      val ok = withContext(Dispatchers.IO) { runCatching { Settings.saveAccess(context, psk, bootstrap, relays, slots) }.getOrDefault(false) }
      if (ok) {
        revision = Settings.revision(context)
        slots = Settings.slots(context).joinToString(",")
        notice = if (vpnUp) R.string.access_saved_reconnect else R.string.access_saved_connect
      } else notice = R.string.access_save_failed
      busy = false
    }
  }

  // An acceptance run cannot tap the update card, and the whole point of the card is what happens after
  // the tap: the download through the tunnel, the digest, the installer. So a run that injected a
  // manifest takes it as soon as the tunnel is up.
  if (autotest && (Updates.injected != null || status.update != null)) {
    LaunchedEffect(vpnUp, status.update?.versionCode) {
      if (vpnUp && status.socksPort != 0) {
        takeUpdate()
        recordAutotest(context, "update requested")
      }
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

  val keySet = Settings.psk(context).isNotBlank()
  val presentation = connectionPresentation(status, vpnUp, starting, keySet, check, engineError, now, ui)
  Column(Modifier.fillMaxSize().systemBarsPadding()) {
    AppHeader(screen, onBack = { back() })
    Box(Modifier.weight(1f)) {
      when (screen) {
        Screen.CONNECT -> ConnectScreen(status, vpnUp, starting, busy, keySet, check, presentation, country,
          if (vpnUp) activeRules ?: savedRules else savedRules, pending, ui.optional(notice),
          onConnect = { connect() }, onDisconnect = { stopVpn(context); notice = 0 },
          onOpen = { open(it) }, onReconnect = { reconnect() },
          update = Updates.offered(context, status.update),
          updateReady = Updates.stagedBuild(context) == Updates.offered(context, status.update)?.versionCode,
          installedBuild = Updates.installedCode(context),
          updateState = updateState,
          onUpdate = { takeUpdate() })
        Screen.RULES -> RulesScreen(rules, savedRules, pending, vpnUp, busy || starting, ui.optional(notice),
          onChange = { rules = it; notice = 0 }, onSave = { saveRules() }, onReconnect = { reconnect() })
        Screen.SETTINGS -> SettingsScreen(keySet, pending, ui.optional(notice), busy || starting, reports, reportsWaiting,
          onOpen = { open(it) },
          onReports = { value ->
            Reports.setEnabled(context, value)
            reports = Reports.enabled(context)
            reportsWaiting = Reports.pending(context).size
          },
          onReconnect = { reconnect() })
        Screen.ACCESS -> AccessScreen(psk, bootstrap, relays, slots, busy || starting, ui.optional(notice), Settings.failureText(context),
          onPsk = { psk = it }, onBootstrap = { bootstrap = it }, onRelays = { relays = it }, onSlots = { slots = it }, onSave = { saveAccess() })
        Screen.COUNTRIES -> CountriesScreen(status, country, ui.optional(notice), onSelect = { code ->
          runCatching {
            if (vpnUp) Mgbox.setCountry(code)
            Settings.setCountry(context, code)
            country = code
            notice = 0
          }.onFailure { notice = R.string.country_save_failed }
        }, onBack = { back() })
        Screen.DIAGNOSTICS -> DiagnosticsScreen(status, vpnUp, check, presentation, engineError, checkingSince != 0L, ui.optional(notice),
          onTest = {
            if (MgVpnService.requestCheck()) { checkingSince = System.currentTimeMillis(); notice = 0 }
            else notice = R.string.check_not_ready
          })
      }
    }
    AppNavigation(screen) { open(it) }
  }
}

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
