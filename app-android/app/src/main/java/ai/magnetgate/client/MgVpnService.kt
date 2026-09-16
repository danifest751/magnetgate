package ai.magnetgate.client

import ai.magnetgate.core.mgbox.Mgbox
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.util.Log
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
    private const val NOTIFICATION_ID = 1

    @Volatile
    private var current: MgVpnService? = null

    /** Whether a tunnel is up, for the screen. */
    fun isRunning(): Boolean = current?.running == true
  }

  private var running = false

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
    val bootstrap = intent?.getStringExtra("bootstrap").orEmpty()
    val relays = intent?.getStringExtra("relays").orEmpty()
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

  private fun startTunnel(bootstrap: String, relays: String, coreless: Boolean) {
    if (running) return
    startForeground(NOTIFICATION_ID, notification("connecting"))

    val port = if (coreless) {
      // diagnostic path: the engine alone, for when the tun itself is what is being questioned
      Log.w(TAG, "started without the core (engine only)")
      0
    } else {
      val psk = CoreConfig.readPsk(this)
      if (psk.isBlank()) throw IllegalStateException("no PSK: put it in files/psk.txt or the settings screen")
      val started = Mgbox.startCore(
        CoreConfig.json(psk, CoreConfig.splitList(bootstrap), CoreConfig.splitList(relays)),
      ).toInt()
      Log.i(TAG, "core listening on 127.0.0.1:$started")
      started
    }

    Mgbox.setupEngine(
      filesDir.absolutePath,
      filesDir.absolutePath,
      cacheDir.absolutePath,
      300L,
      false,
    )

    Mgbox.startEngine(SingBoxConfig.build(port, coreless), MgTunPlatform(this))
    running = true
    Log.i(TAG, "tunnel up (engine ${Mgbox.coreVersion()}, core $port)")
    notify(notification("connected"))
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
    if (!running) return
    running = false
    try {
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
