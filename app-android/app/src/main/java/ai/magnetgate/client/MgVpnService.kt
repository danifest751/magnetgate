package ai.magnetgate.client

import ai.magnetgate.core.mgbox.Mgbox
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.VpnService
import android.os.Build
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
    private const val NOTIFICATION_ID = 1

    @Volatile
    private var current: MgVpnService? = null

    /** Whether a tunnel is up, for the screen. */
    fun isRunning(): Boolean = current?.running == true
  }

  private var running = false
  private var starting = false
  private var watching = false
  private var corePort = 0

  /** The packages the tunnel must leave alone, read from settings when the tunnel comes up. */
  private var excludedPackages: List<String> = emptyList()

  override fun onCreate() {
    super.onCreate()
    current = this
    createChannel()
  }

  override fun onDestroy() {
    current = null
    super.onDestroy()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopTunnel()
      stopSelf()
      return START_NOT_STICKY
    }
    // The extras exist for the acceptance scripts, which point a run at their own stand; the screens
    // leave them empty, and then the saved settings decide what this client looks for.
    val bootstrap = intent?.getStringExtra("bootstrap").orEmpty().ifBlank { Settings.bootstrap(this) }
    val relays = intent?.getStringExtra("relays").orEmpty().ifBlank { Settings.relays(this) }
    val coreless = intent?.getBooleanExtra("coreless", false) == true
    try {
      startTunnel(bootstrap, relays, coreless)
    } catch (error: Throwable) {
      Log.e(TAG, "the tunnel did not start: ${error.message}", error)
      stopTunnel()
      stopSelf()
    }
    return START_STICKY
  }

  /**
   * Starts the core, waits until it has found a node (a tunnel with nowhere to go is not a tunnel), builds
   * the engine's configuration from what was found, starts the engine and tells the core which loopback
   * listener carries which of the node's planes.
   *
   * It runs off the main thread: discovery takes seconds, and the service must not block the UI.
   */
  private fun startTunnel(bootstrap: String, relays: String, coreless: Boolean) {
    if (running || starting) return
    starting = true
    startForeground(NOTIFICATION_ID, notification("looking for a node"))
    Thread {
      try {
        val port = if (coreless) 0 else startCoreAndWaitForNode(bootstrap, relays)
        val nodes = if (coreless) emptyList() else discoveredNodes()
        excludedPackages = Settings.excluded(this)
        val built = SingBoxConfig.build(port, coreless, nodes, excludedPackages)

        Mgbox.setupEngine(filesDir.absolutePath, filesDir.absolutePath, cacheDir.absolutePath, 300L, false)
        Mgbox.startEngine(built.json, MgTunPlatform(this))
        for (plane in built.planes) {
          Mgbox.setPlaneSocksPort(plane.slot.toLong(), plane.plane, plane.port.toLong())
        }
        running = true
        corePort = port
        watching = true
        Log.i(TAG, "tunnel up (engine ${Mgbox.coreVersion()}, core $port, engine planes ${built.planes.size}, excluded apps ${excludedPackages.size})")
        notify(notification("connected"))
        watchNodes()
      } catch (error: Throwable) {
        Log.e(TAG, "the tunnel did not start: ${error.message}", error)
        stopTunnel()
        stopSelf()
      } finally {
        starting = false
      }
    }.start()
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
    while (watching) {
      Thread.sleep(NODE_WATCH_INTERVAL_MS)
      if (!watching) return
      val next = nodeSignature()
      if (next == signature) continue
      signature = next
      try {
        val nodes = discoveredNodes()
        val built = SingBoxConfig.build(corePort, false, nodes, excludedPackages)
        Mgbox.forgetPlaneSocksPorts()
        Mgbox.reloadEngine(built.json)
        for (plane in built.planes) {
          Mgbox.setPlaneSocksPort(plane.slot.toLong(), plane.plane, plane.port.toLong())
        }
        Log.i(TAG, "engine reloaded for ${nodes.size} node(s), ${built.planes.size} engine plane(s)")
      } catch (error: Throwable) {
        Log.w(TAG, "the engine was not reloaded: ${error.message}")
      }
    }
  }

  /** The node and plane set, as a value that only changes when the configuration should change. */
  private fun nodeSignature(): String =
    discoveredNodes().joinToString(",") { node ->
      "${node.slot}:" + node.planes.joinToString("+") { it.optString("t") }
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
    forEachString(request.optJSONArray("ExcludePackage")) { builder.addDisallowedApplication(it) }

    // The core's own sockets must not enter this tunnel, and it runs in this app's process, so the app
    // excludes itself. The engine's sockets are protected one by one instead.
    builder.addDisallowedApplication(packageName)

    val descriptor = builder.establish() ?: throw IllegalStateException("VpnService.establish returned nothing")
    val fd = descriptor.detachFd()
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
    try {
      Mgbox.forgetPlaneSocksPorts()
      Mgbox.stopEngine()
    } catch (error: Throwable) {
      Log.w(TAG, "closing the engine: ${error.message}")
    }
    Mgbox.stopCore()
    stopForeground(STOP_FOREGROUND_REMOVE)
    Log.i(TAG, "tunnel down")
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
