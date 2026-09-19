package ai.magnetgate.client

import ai.magnetgate.core.mgbox.Mgbox
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * The tunnel: a VpnService that owns both halves of the client.
 *
 * It starts the core (which discovers an exit and serves SOCKS on loopback), then hands the engine a
 * configuration whose only outbound is that SOCKS listener, and gives the engine the tun descriptor it
 * asks for. Everything the app sends or receives in the tunnel therefore travels
 * tun -> sing-box -> core -> exit, while the app's own traffic stays out of it (see the platform handler).
 *
 * The core and the engine live in one binding, which is what makes this possible at all: two gomobile
 * bindings would be two Go runtimes in one process, and the engine's callbacks into Java do not survive
 * that.
 */
class MgVpnService : VpnService() {

  companion object {
    const val TAG = "magnetgate"
    const val ACTION_START = "ai.magnetgate.client.action.START"
    const val ACTION_STOP = "ai.magnetgate.client.action.STOP"

    private const val CHANNEL_ID = "magnetgate"
    private const val DISCOVERY_TIMEOUT_MS = 90_000L
    private const val NODE_WATCH_INTERVAL_MS = 5_000L

    /**
     * How often the exit is measured while the tunnel is up. It runs here rather than on the screen so
     * that it keeps running with the app closed, which is when a tunnel is normally used: the regress
     * this answers was noticed by a person opening web pages, not by anyone watching a screen.
     */
    private const val CHECK_INTERVAL_MS = 60_000L
    private const val CHECK_URL = "https://api.ipify.org"

    /** How large the engine's log may grow before it is emptied; one generation of it is also kept. */
    private const val MAX_ENGINE_LOG = 16L * 1024 * 1024

    /** Every measurement, one line each, so a whole session can be read as a curve; see [recordCheck]. */
    private const val HEALTH_FILE = "health.csv"
    private const val MAX_HEALTH_FILE = 2L * 1024 * 1024
    private const val NOTIFICATION_ID = 1

    @Volatile
    private var current: MgVpnService? = null

    /** Whether a tunnel is up, for the screen. */
    fun isRunning(): Boolean = current?.running == true

    fun isStarting(): Boolean = current?.let { it.starting && !it.running } == true
    fun hasInstance(): Boolean = current != null
    fun appliedSettingsRevision(): Long = current?.appliedRevision ?: -1L
    fun appliedRouting(): RoutingDraft? = current?.activeRouting

    /** Проверка выполняется тем же наблюдателем и через тот же DNS-путь, что и фоновая. */
    fun requestCheck(): Boolean {
      val service = current?.takeIf { it.running } ?: return false
      service.checkRequested = true
      return true
    }

    /**
     * Whether the service owns the core - already, or in a moment.
     *
     * [isRunning] turns true only once the engine is up, roughly a second after the service has started
     * the core. Anything that asks "may I start a core?" has to use this instead: in that second the
     * screen started a second core, the engine was handed the port of the first, and the tunnel carried
     * nothing while looking perfectly healthy.
     */
    fun ownsCore(): Boolean = current?.let { it.running || it.starting } == true
  }

  @Volatile internal var running = false
  @Volatile internal var starting = false
  @Volatile private var appliedRevision = -1L
  @Volatile private var activeRouting: RoutingDraft? = null
  @Volatile private var checkRequested = false
  private var watching = false

  /** The manifest already acted on to a settled end, so it is not worked through again every tick. */
  private var settledRuleSets: String? = null
  private var corePort = 0

  /**
   * The engine listener the health check goes through. It changes with every engine reload, because the
   * loopback ports are picked afresh each time - so it is written wherever a configuration is built, and
   * never remembered across one.
   */
  private var checkPort = 0

  /** The packages the tunnel must leave alone - or carry, and only them - read when it comes up. */
  private var excludedPackages: List<String> = emptyList()
  private var appsMode: Settings.Apps = Settings.Apps.EXCEPT

  /**
   * Watches the network under the tunnel and tells the engine when it changes.
   *
   * Android moves a VPN between networks whenever it likes - Wi-Fi sleeps, the radio re-registers, the
   * phone is carried outside - and usually while nobody is looking. The engine has no way to notice on
   * its own: it is inside an app, its sockets are protected rather than bound, and everything it knows
   * about the network it was told at startup. Measured twice on the owner's phone: every long-lived
   * connection aborted in the same second, and every dial after that answered `network is unreachable`
   * until the tunnel was restarted by hand.
   */
  private var networkWatch: ConnectivityManager.NetworkCallback? = null

  /** The interface last reported, so the same network is not announced on every capability change. */
  private var lastNetwork = ""

  /** Where the engine writes its own log for this tunnel; see [prepareEngineLog]. */
  private var engineLog = ""

  /**
   * How loudly the engine writes it, for this tunnel only.
   *
   * A hunt wants `debug` - it is the only level that says what the sniffer read and why a connection
   * waited - and no one wants it every day. So it arrives as a launch extra and dies with the tunnel.
   */
  private var engineLogLevel = "info"

  /**
   * The slot whose exits are pointed at a black hole for this tunnel, or -1.
   *
   * An acceptance run asks for it with `-e breakslot <n>`, and only a debuggable build listens: it makes
   * one node's path dead on demand, which is the only way to check that the client leaves such a path
   * without stopping a service that other people are using. Like every hook here, it dies with the
   * tunnel.
   */
  private var brokenSlot = -1

  /**
   * The routing policy as it was when the tunnel came up. It is captured once rather than re-read on
   * every engine reload: a reload happens because the set of nodes changed, and it must not quietly
   * adopt a mode the user picked afterwards - that would move traffic without them reconnecting.
   */
  private data class Policy(
    val mode: Settings.Mode = Settings.Mode.FULL,
    val directDomains: List<String> = emptyList(),
    val tunnelDomains: List<String> = emptyList(),
    val ruleSets: List<RuleSets.Available> = emptyList(),
  )

  private var policy: Policy = Policy()

  /**
   * The tun device this service owns. It stays open until the tunnel goes down: libbox duplicates the fd
   * the platform hands it, so its copy goes away with the engine, while this one is ours to close. Left
   * open, the interface outlives the tunnel and every reconnect leaves another one behind.
   */
  private var tun: ParcelFileDescriptor? = null

  override fun onCreate() {
    super.onCreate()
    current = this
    createChannel()
  }

  override fun onDestroy() {
    current = null
    // the interface must not outlive the service that owns it
    runCatching { tun?.close() }.onFailure { Log.w(TAG, "closing the tun: ${it.message}") }
    tun = null
    super.onDestroy()
  }

  /**
   * Whether this build may be driven from a shell; the same gate the launch hooks in the activity use.
   */
  private fun debuggable(): Boolean =
    (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0

  /**
   * The VPN was taken away: the user revoked it, or gave it to another app.
   *
   * That is a decision, not a failure, so the wish goes with it. Without this the watchdog would find
   * "wanted and not up" once a minute for as long as the other VPN lasts, and say so in the log every
   * time - and the one thing it must never do is take the tunnel back from an app the user chose.
   */
  override fun onRevoke() {
    Log.w(TAG, "the VPN was revoked; the tunnel is no longer wanted")
    Watchdog.want(this, false)
    stopTunnel()
    stopSelf()
    super.onRevoke()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      // The wish is withdrawn before the tunnel goes down, so that a watchdog tick arriving in between
      // finds "not wanted" rather than "wanted and not up" and reconnects a VPN somebody just switched
      // off.
      Watchdog.want(this, false)
      stopTunnel()
      stopSelf()
      return START_NOT_STICKY
    }
    // Every road to a tunnel passes here - the screen, an acceptance run, always-on after a reboot, the
    // watchdog itself - so this is the one place that can say "from now on, this phone wants a tunnel".
    // It is recorded before the tunnel is built rather than after: a start that fails half-way through
    // discovery is exactly a case the watchdog should retry.
    Watchdog.want(this, true)
    // The extras exist for the acceptance scripts, which point a run at their own stand; the screens
    // leave them empty, and then the saved settings decide what this client looks for. A channel named
    // `none` is off for this run, which is how a script proves one channel on its own (Settings.channel).
    val bootstrap = Settings.channel(intent?.getStringExtra("bootstrap").orEmpty(), Settings.bootstrap(this))
    val relays = Settings.channel(intent?.getStringExtra("relays").orEmpty(), Settings.relays(this))
    val coreless = intent?.getBooleanExtra("coreless", false) == true
    val modeExtra = intent?.getStringExtra("mode").orEmpty()
    engineLogLevel = when (intent?.getStringExtra("enginelog")?.lowercase()) {
      "trace", "debug", "info", "warn", "error" -> intent.getStringExtra("enginelog")!!.lowercase()
      else -> "info"
    }
    brokenSlot = intent?.getStringExtra("breakslot")?.toIntOrNull()?.takeIf { debuggable() } ?: -1
    if (brokenSlot >= 0) Log.w(TAG, "acceptance hook: slot $brokenSlot is pointed at a black hole")
    try {
      startTunnel(bootstrap, relays, coreless, modeExtra)
    } catch (error: Throwable) {
      Log.e(TAG, "the tunnel did not start: ${error.message}", error)
      Health.recordEngineError("the tunnel did not start: ${error.message}")
      stopTunnel()
      stopSelf()
    }
    return START_STICKY
  }

  /**
   * Prepares the engine's log file for a new tunnel and keeps the previous one beside it.
   *
   * Keeping one generation is the whole point. When a tunnel that has been up for hours starts resetting
   * connections, the thing that fixes it is a restart - and the restart would erase the only record of
   * what went wrong, which is exactly what happened on 17.09 (trap 79). The previous log survives as
   * `engine.log.1`.
   *
   * The engine logs what it carries, so this file names the hosts this phone visits. It lives in the
   * app's private directory and is bounded: one generation kept, each dropped once it passes
   * [MAX_ENGINE_LOG].
   */
  private fun prepareEngineLog(): String {
    val log = java.io.File(filesDir, "engine.log")
    val previous = java.io.File(filesDir, "engine.log.1")
    runCatching {
      if (previous.exists()) previous.delete()
      if (log.exists()) {
        if (log.length() > MAX_ENGINE_LOG) log.delete() else log.renameTo(previous)
      }
    }.onFailure { Log.w(TAG, "rotating the engine log: ${it.message}") }
    return log.absolutePath
  }

  /**
   * Writes every measurement down, one line per check, for as long as the tunnel is up.
   *
   * Until now a measurement lived in memory and reached a file only when someone asked for a dump - and
   * asking means starting the activity, which on the owner's phone means taking over their screen. So a
   * whole evening of degradation left exactly one reading: the last one. The session of 18.09 was
   * diagnosed from the engine's log while the one number that would have said "the path itself got three
   * times slower" existed once, by luck, two minutes before the tunnel was switched off.
   *
   * The file is plain text and append-only, so it can be pulled over the cable at any moment without
   * touching the phone: `adb shell run-as … cat files/health.csv`.
   */
  private fun recordCheck(check: Health.Check) {
    runCatching {
      val file = java.io.File(filesDir, HEALTH_FILE)
      // A day of checks is 1440 lines of some 60 bytes; the cap is generous and exists only so that a
      // phone left running for a month does not carry a file nobody will ever read to its end.
      if (file.length() > MAX_HEALTH_FILE) file.delete()
      if (!file.exists()) file.appendText("at,ok,tookMs,connectMs,tlsMs,answerMs,pingMs,detail\n")
      val legs = check.legs
      file.appendText(
        "${check.atMs},${if (check.ok) 1 else 0},${check.tookMs}," +
          "${legs?.connectMs ?: ""},${legs?.tlsMs ?: ""},${legs?.answerMs ?: ""},${legs?.pingMs ?: ""}," +
          check.detail.replace(',', ' ').replace('\n', ' ') + "\n",
      )
    }.onFailure { Log.w(TAG, "recording the measurement: ${it.message}") }
  }

  /**
   * Keeps the running tunnel's log from growing without end.
   *
   * sing-box opens it with O_APPEND (log/observable.go), so emptying the file under it is safe: the next
   * write goes to the new end rather than leaving a hole. Truncating loses history, which is why the cap
   * is generous - a session that writes this much has plenty of recent evidence left.
   */
  private fun trimEngineLog() {
    if (engineLog.isEmpty()) return
    val log = java.io.File(engineLog)
    runCatching {
      if (log.length() > MAX_ENGINE_LOG) {
        java.io.FileOutputStream(log, false).close()
        Log.i(TAG, "the engine log passed ${MAX_ENGINE_LOG / (1024 * 1024)} MB and was emptied")
      }
    }.onFailure { Log.w(TAG, "trimming the engine log: ${it.message}") }
  }

  /**
   * Starts the core, waits until it has found a node (a tunnel with nowhere to go is not a tunnel), builds
   * the engine's configuration from what was found, starts the engine and tells the core which loopback
   * listener carries which of the node's planes.
   *
   * It runs off the main thread: discovery takes seconds, and the service must not block the UI.
   */
  private fun startTunnel(bootstrap: String, relays: String, coreless: Boolean, modeExtra: String) {
    if (running || starting) return
    val revision = Settings.revision(this)
    starting = true
    // a new tunnel must not be judged by the previous one's measurements
    Health.reset()
    startForeground(NOTIFICATION_ID, notification("looking for a node"))
    Thread {
      try {
        val port = if (coreless) 0 else startCoreAndWaitForNode(bootstrap, relays)
        val nodes = if (coreless) emptyList() else discoveredNodes()
        excludedPackages = Settings.excluded(this)
        appsMode = Settings.apps(this)
        policy = Policy(
          // an acceptance run may name the mode; otherwise the stored setting decides
          mode = if (modeExtra.isBlank()) Settings.mode(this) else Settings.Mode.of(modeExtra),
          directDomains = Settings.directDomains(this),
          tunnelDomains = Settings.tunnelDomains(this),
          ruleSets = RuleSets.ensure(this),
        )
        engineLog = prepareEngineLog()
        val built = SingBoxConfig.build(
          port, coreless, nodes, excludedPackages,
          policy.mode, policy.directDomains, policy.tunnelDomains, policy.ruleSets, engineLog, engineLogLevel,
          brokenSlot, appsMode,
        )

        Mgbox.setupEngine(filesDir.absolutePath, filesDir.absolutePath, cacheDir.absolutePath, 300L, false)
        Mgbox.startEngine(built.json, MgTunPlatform(this))
        for (plane in built.planes) {
          Mgbox.setPlaneSocksPort(plane.slot.toLong(), plane.plane, plane.port.toLong())
        }
        // The country the user prefers is told to the core once it is up: it changes which node the next
        // stream prefers, not how anything is built, so it never needs a reconnect.
        runCatching { Mgbox.setCountry(Settings.country(this)) }
          .onFailure { Log.w(TAG, "the country preference did not reach the core: ${it.message}") }
        activeRouting = RoutingDraft(policy.mode, appsMode, excludedPackages.toSet(), policy.directDomains, policy.tunnelDomains)
        appliedRevision = revision
        running = true
        corePort = port
        watchNetwork()
        checkPort = built.checkPort
        watching = true
        Log.i(
          TAG,
          "tunnel up (engine ${Mgbox.coreVersion()}, core $port, engine planes ${built.planes.size}, " +
            "excluded apps ${excludedPackages.size}, mode ${policy.mode.stored}, " +
            "rule-sets ${policy.ruleSets.size}, direct ${policy.directDomains.size}, tunnel ${policy.tunnelDomains.size})",
        )
        notify(notification("connected"))
        refreshRuleSets()
        watchNodes()
      } catch (error: Throwable) {
        Log.e(TAG, "the tunnel did not start: ${error.message}", error)
        Health.recordEngineError("the tunnel did not start: ${error.message}")
        stopTunnel()
        stopSelf()
      } finally {
        starting = false
      }
    }.start()
  }

  /**
   * Brings the routing lists up to date from what a node advertises.
   *
   * It runs after the tunnel is up, and on purpose: the download goes through the core's own SOCKS
   * listener, so it takes the same path the traffic does rather than leaving the device in the clear.
   *
   * A failure here is never fatal. The lists already on disk keep working, and a set whose digest does
   * not match what the operator published is discarded rather than installed - the checksum is the whole
   * control, since the file itself comes from wherever the manifest points.
   */
  private fun refreshRuleSets() {
    // A manifest travels in the Nostr offer only, which may arrive well after the tunnel is up, or not
    // at all on a network where no relay answers. So this runs on every node-watch tick rather than
    // once at start-up, and remembers a manifest only once acting on it has settled: a source that
    // could not be reached is tried again, one serving the wrong bytes is not re-fetched every tick.
    val manifest = advertisedRuleSets() ?: return
    val seen = manifest.toString()
    if (seen == settledRuleSets) return
    try {
      val result = RuleSets.update(this, manifest, corePort)
      if (result.settled) settledRuleSets = seen
      if (!result.changed) return
      // The engine reads a rule-set from a path when it starts, so a replaced file means nothing until
      // it is told to read again.
      policy = policy.copy(ruleSets = RuleSets.ensure(this))
      val built = SingBoxConfig.build(
        corePort, false, discoveredNodes(), excludedPackages,
        policy.mode, policy.directDomains, policy.tunnelDomains, policy.ruleSets, engineLog, engineLogLevel,
        brokenSlot, appsMode,
      )
      Mgbox.forgetPlaneSocksPorts()
      Mgbox.reloadEngine(built.json)
      checkPort = built.checkPort
      for (plane in built.planes) {
        Mgbox.setPlaneSocksPort(plane.slot.toLong(), plane.plane, plane.port.toLong())
      }
      Log.i(TAG, "rule-sets: engine reloaded on generation ${RuleSets.generation(this)}")
    } catch (error: Throwable) {
      Log.w(TAG, "rule-sets: not refreshed: ${error.message}")
      Health.recordEngineError("rule-sets: not refreshed: ${error.message}")
    }
  }

  /**
   * The rule-set manifest to follow, or null when no node carries one.
   *
   * The newest generation wins rather than whichever node was discovered first. Nodes are deployed one
   * at a time, so for a while they disagree, and taking the first one made the client's choice depend on
   * the order discovery happened to finish in - including silently preferring a stale manifest over a
   * fresh one.
   */
  private fun advertisedRuleSets(): JSONObject? {
    val status = runCatching { Mgbox.coreStatus() }.getOrNull() ?: return null
    val exits = runCatching { JSONObject(status).optJSONObject("snapshot")?.optJSONArray("exits") }
      .getOrNull() ?: return null
    var newest: JSONObject? = null
    for (index in 0 until exits.length()) {
      val manifest = exits.optJSONObject(index)?.optJSONObject("rs") ?: continue
      if (newest == null || manifest.optInt("v", 0) > newest.optInt("v", 0)) newest = manifest
    }
    return newest
  }

  /**
   * Follows the set of nodes the core knows.
   *
   * The engine's configuration is a snapshot, so when a node appears (or goes away) the snapshot is rebuilt
   * from what the core reports and handed to the running engine. The signature is the node and plane set
   * alone: the loopback ports change with every build, and reloading for those would be a loop.
   */
  private fun watchNodes() {
    var signature = nodeSignature()
    var checkedAt = 0L
    while (watching) {
      Thread.sleep(NODE_WATCH_INTERVAL_MS)
      if (!watching) return
      // the manifest can arrive, or change, without the node set changing at all
      refreshRuleSets()
      // through the engine when there is one: that path resolves the name with the engine's own resolver,
      // which is the half a check through the core's SOCKS never touches
      val through = if (checkPort != 0) checkPort else corePort
      if ((checkRequested || System.currentTimeMillis() - checkedAt >= CHECK_INTERVAL_MS) && through != 0) {
        checkRequested = false
        checkedAt = System.currentTimeMillis()
        recordCheck(Health.check(through, CHECK_URL))
        trimEngineLog()
      }
      val next = nodeSignature()
      if (next == signature) continue
      signature = next
      try {
        // the core may have restarted under us; the engine has to be told where it lives now
        val port = liveCorePort()
        if (port != corePort) {
          Log.i(TAG, "the core moved from port $corePort to $port, rebuilding the engine")
          corePort = port
        }
        val nodes = discoveredNodes()
        val built = SingBoxConfig.build(
          corePort, false, nodes, excludedPackages,
          policy.mode, policy.directDomains, policy.tunnelDomains, policy.ruleSets, engineLog, engineLogLevel,
        )
        Mgbox.forgetPlaneSocksPorts()
        Mgbox.reloadEngine(built.json)
        checkPort = built.checkPort
        for (plane in built.planes) {
          Mgbox.setPlaneSocksPort(plane.slot.toLong(), plane.plane, plane.port.toLong())
        }
        Log.i(TAG, "engine reloaded for ${nodes.size} node(s), ${built.planes.size} engine plane(s)")
      } catch (error: Throwable) {
        Log.w(TAG, "the engine was not reloaded: ${error.message}")
        Health.recordEngineError("the engine was not reloaded: ${error.message}")
      }
    }
  }

  /**
   * The node and plane set plus the core's port, as a value that only changes when the configuration
   * should change.
   *
   * The port is in here because the core restarts on its own: the screen brings it up, and a Go core
   * asked to start again replaces itself and hands back a **new** port (see the handoff, trap 39). The
   * engine keeps dialling the old one, which nothing is listening on any more - the tun is up, the node
   * list looks healthy, and not a byte moves. That happened on the phone on 17.09 and cost the owner
   * their connection until the tunnel was restarted by hand.
   */
  private fun nodeSignature(): String {
    val nodes = discoveredNodes().joinToString(",") { node ->
      "${node.slot}:" + node.planes.joinToString("+") { it.optString("t") }
    }
    return "$nodes@${liveCorePort()}"
  }

  /** The port the core is listening on right now, which is the only one worth believing. */
  private fun liveCorePort(): Int {
    val status = runCatching { Mgbox.coreStatus() }.getOrNull() ?: return corePort
    return runCatching { JSONObject(status).optInt("socksPort") }.getOrNull()?.takeIf { it != 0 } ?: corePort
  }


  /** Starts the core and waits for the first discovered node. */
  private fun startCoreAndWaitForNode(bootstrap: String, relays: String): Int {
    val psk = CoreConfig.readPsk(this)
    if (psk.isBlank()) throw IllegalStateException("no PSK: put it in files/psk.txt or the settings screen")
    val port = Mgbox.startCore(
      CoreConfig.json(
        psk = psk,
        slots = Settings.slots(this),
        bootstrap = CoreConfig.splitList(bootstrap),
        relays = CoreConfig.splitList(relays),
      ),
    ).toInt()
    Log.i(TAG, "core listening on 127.0.0.1:$port")

    val deadline = System.currentTimeMillis() + DISCOVERY_TIMEOUT_MS
    while (System.currentTimeMillis() < deadline) {
      if (discoveredNodes().isNotEmpty()) return port
      Thread.sleep(1000)
    }
    throw IllegalStateException("no exit was discovered within ${DISCOVERY_TIMEOUT_MS / 1000} s")
  }

  /** The nodes the core knows right now, with the transports they advertise. */
  private fun discoveredNodes(): List<DiscoveredNode> {
    val status = runCatching { Mgbox.coreStatus() }.getOrNull() ?: return emptyList()
    val snapshot = runCatching { JSONObject(status).optJSONObject("snapshot") }.getOrNull() ?: return emptyList()
    val exits = snapshot.optJSONArray("exits") ?: return emptyList()
    val nodes = mutableListOf<DiscoveredNode>()
    for (index in 0 until exits.length()) {
      val exit = exits.optJSONObject(index) ?: continue
      val planes = mutableListOf<JSONObject>()
      val dp = exit.optJSONArray("dp") ?: JSONArray()
      for (plane in 0 until dp.length()) dp.optJSONObject(plane)?.let { planes.add(it) }
      nodes.add(DiscoveredNode(exit.optInt("slot"), planes))
    }
    return nodes
  }

  /**
   * Builds the tun the engine asked for. It lives here because a VpnService may only be configured from
   * inside the service itself, and because this is the one place that knows the app must stay out of its
   * own tunnel - the core's sockets (native session, DHT, relays) run in this process.
   */
  internal fun establishTun(request: JSONObject): Int {
    val builder = Builder()
    builder.setSession("MagnetGate")
    builder.setMtu(request.optInt("MTU", 1500))

    addAddresses(builder, request.optJSONArray("Inet4Address")) { address, prefix -> builder.addAddress(address, prefix) }
    addAddresses(builder, request.optJSONArray("Inet6Address")) { address, prefix -> builder.addAddress(address, prefix) }
    val addresses6 = request.optJSONArray("Inet6Address")
    val hasIpv6 = addresses6 != null && addresses6.length() > 0
    if (request.optBoolean("AutoRoute", true)) {
      addAddresses(builder, request.optJSONArray("Inet4RouteAddress")) { address, prefix -> builder.addRoute(address, prefix) }
      addAddresses(builder, request.optJSONArray("Inet6RouteAddress")) { address, prefix -> builder.addRoute(address, prefix) }
      // A VPN has to capture everything: the engine decides where traffic goes, but the tun only sees what
      // the platform routes into it, and the engine's own route list is about its internal rules.
      builder.addRoute("0.0.0.0", 0)
      if (hasIpv6) builder.addRoute("::", 0)
    }
    Log.i(TAG, "tun request: $request")
    forEachString(request.optJSONArray("DNSServerAddress")) { builder.addDnsServer(it) }

    // Android refuses to mix the two lists, so this is one choice and not two. A named package that is
    // no longer installed throws, and an app the user removed must not be the reason a tunnel fails to
    // come up: each name is applied on its own and a missing one is logged and skipped.
    val include = request.optJSONArray("IncludePackage")
    if (include != null && include.length() > 0) {
      // "Only these apps": everything else, this app included, stays on the ordinary network - which is
      // why nothing is excluded here. Our own sockets are out of the tunnel by construction.
      forEachString(include) {
        runCatching { builder.addAllowedApplication(it) }
          .onFailure { error -> Log.w(TAG, "not tunnelling $it: ${error.message}") }
      }
    } else {
      forEachString(request.optJSONArray("ExcludePackage")) {
        runCatching { builder.addDisallowedApplication(it) }
          .onFailure { error -> Log.w(TAG, "not excluding $it: ${error.message}") }
      }
      // The core's own sockets must not enter this tunnel, and it runs in this app's process, so the app
      // excludes itself. The engine's sockets are protected one by one instead.
      builder.addDisallowedApplication(packageName)
    }

    val descriptor = builder.establish() ?: throw IllegalStateException("VpnService.establish returned nothing")
    // the engine duplicates this fd, so replacing a tunnel means dropping ours - the old interface would
    // otherwise stay up with its routes for as long as the process lives
    tun?.close()
    tun = descriptor
    val fd = descriptor.fd
    Log.i(TAG, "tun established, fd=$fd")
    return fd
  }

  private fun addAddresses(
    builder: Builder,
    addresses: org.json.JSONArray?,
    add: (String, Int) -> Unit,
  ) {
    if (addresses == null) return
    for (index in 0 until addresses.length()) {
      val value = addresses.optString(index)
      val slash = value.lastIndexOf('/')
      if (slash <= 0) continue
      val prefix = value.substring(slash + 1).toIntOrNull() ?: continue
      add(value.substring(0, slash), prefix)
    }
  }

  private fun forEachString(values: org.json.JSONArray?, action: (String) -> Unit) {
    if (values == null) return
    for (index in 0 until values.length()) action(values.optString(index))
  }

  internal fun stopTunnel() {
    if (!running && !starting) return
    running = false
    starting = false
    watching = false
    forgetNetwork()
    try {
      Mgbox.forgetPlaneSocksPorts()
      Mgbox.stopEngine()
    } catch (error: Throwable) {
      Log.w(TAG, "closing the engine: ${error.message}")
    }
    // after the engine is gone its duplicate is closed, and this is the only fd left holding the
    // interface up
    runCatching { tun?.close() }.onFailure { Log.w(TAG, "closing the tun: ${it.message}") }
    tun = null
    Mgbox.stopCore()
    stopForeground(STOP_FOREGROUND_REMOVE)
    Log.i(TAG, "tunnel down")
  }

  /**
   * Starts reporting Android's default network to the engine, and reports it once right away.
   *
   * The callback is the system's own view of "what this phone is using", which is exactly what the
   * engine's outbound sockets end up on. `onLost` with nothing to take over is reported as index -1:
   * no network at all is a state the engine has to know, not a gap in the reporting.
   */
  private fun watchNetwork() {
    if (networkWatch != null) return
    val manager = getSystemService(ConnectivityManager::class.java) ?: return
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) = report(network)

      override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) =
        report(network, properties)

      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) =
        report(network, capabilities = capabilities)

      override fun onLost(network: Network) {
        Log.i(TAG, "the network under the tunnel went away")
        runCatching { Mgbox.updateDefaultInterface("", -1L, false) }
          .onFailure { Log.w(TAG, "telling the engine the network is gone: ${it.message}") }
      }

      private fun report(
        network: Network,
        properties: LinkProperties? = null,
        capabilities: NetworkCapabilities? = null,
      ) {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return
        val link = properties ?: manager.getLinkProperties(network)
        val name = link?.interfaceName ?: return
        // the engine needs the index, which only the interface itself can give
        val index = runCatching { java.net.NetworkInterface.getByName(name)?.index ?: -1 }.getOrDefault(-1)
        val able = capabilities ?: manager.getNetworkCapabilities(network)
        // belt and braces: our own tunnel is never the network the tunnel rides on
        if (able?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true) return
        val expensive = able?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) != true
        if (index <= 0) return
        if (name == lastNetwork) return
        lastNetwork = name
        Log.i(TAG, "the tunnel now rides $name (index $index, metered $expensive)")
        runCatching { Mgbox.updateDefaultInterface(name, index.toLong(), expensive) }
          .onFailure { Log.w(TAG, "telling the engine about $name: ${it.message}") }
      }
    }
    // Not the default network: once the tunnel is up, that is the tunnel itself, and the engine would
    // be told it rides tun0 - measured on the first try. What matters is the network underneath, so the
    // request asks for one that is not a VPN.
    val request = android.net.NetworkRequest.Builder()
      .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
      .build()
    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        // one callback that follows the best match, rather than one event per candidate network
        manager.registerBestMatchingNetworkCallback(request, callback, android.os.Handler(mainLooper))
      } else {
        manager.registerNetworkCallback(request, callback)
      }
    }
      .onSuccess { networkWatch = callback }
      .onFailure { Log.w(TAG, "watching the network: ${it.message}") }
  }

  private fun forgetNetwork() {
    val callback = networkWatch ?: return
    networkWatch = null
    lastNetwork = ""
    val manager = getSystemService(ConnectivityManager::class.java)
    runCatching { manager?.unregisterNetworkCallback(callback) }
      .onFailure { Log.w(TAG, "unwatching the network: ${it.message}") }
  }

  private fun createChannel() {
    val manager = getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "MagnetGate", NotificationManager.IMPORTANCE_LOW),
      )
    }
  }

  private fun notification(text: String): Notification {
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
    return builder
      .setContentTitle("MagnetGate")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setOngoing(true)
      .build()
  }

  private fun notify(notification: Notification) {
    val manager = getSystemService(NotificationManager::class.java)
    manager.notify(NOTIFICATION_ID, notification)
  }
}
