package ai.magnetgate.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.util.Log
import io.nekohasekai.libbox.CommandServer
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.OverrideOptions
import io.nekohasekai.libbox.RoutePrefixIterator
import io.nekohasekai.libbox.SetupOptions
import io.nekohasekai.libbox.StringIterator
import io.nekohasekai.libbox.TunOptions
import mobile.Mobile

/**
 * The tunnel: a VpnService that owns both halves of the client.
 *
 * It starts the core (which discovers an exit and serves SOCKS on loopback), then hands the engine a
 * configuration whose only outbound is that SOCKS listener, and gives the engine the tun descriptor it
 * asks for. Everything the app sends or receives in the tunnel therefore travels
 * tun -> sing-box -> core -> exit, while the app's own traffic stays out of it (see PlatformInterface).
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

    /** The engine asked to stop (its own callback, not the user). */
    internal fun requestStop() {
      current?.stopTunnel()
    }
  }

  private var running = false
  private var server: CommandServer? = null

  /**
   * Builds the tun the engine asked for. It lives here because a VpnService may only be configured from
   * inside the service itself, and because this is the one place that knows the app must stay out of its
   * own tunnel.
   */
  internal fun establishTun(options: TunOptions): Int {
    val builder = Builder()
    builder.setSession("MagnetGate")
    builder.setMtu(options.mtu)

    forEachPrefix(options.inet4Address) { address, prefix -> builder.addAddress(address, prefix) }
    forEachPrefix(options.inet6Address) { address, prefix -> builder.addAddress(address, prefix) }

    if (options.autoRoute) {
      forEachPrefix(options.inet4RouteAddress) { address, prefix -> builder.addRoute(address, prefix) }
      forEachPrefix(options.inet6RouteAddress) { address, prefix -> builder.addRoute(address, prefix) }
    }

    forEachString(options.dnsServerAddress) { builder.addDnsServer(it) }
    forEachString(options.excludePackage) { builder.addDisallowedApplication(it) }

    // The core's sockets (native session, DHT, relays) must not enter this tunnel, and the core runs in
    // this app's process, so the app excludes itself. That is also why no socket needs protecting.
    builder.addDisallowedApplication(packageName)

    val descriptor = builder.establish() ?: throw IllegalStateException("VpnService.establish returned nothing")
    val fd = descriptor.detachFd()
    Log.i(TAG, "tun established, fd=$fd")
    return fd
  }

  /** gomobile hands Go iterators over as hasNext/next, not as Java collections. */
  private fun forEachPrefix(iterator: RoutePrefixIterator?, action: (String, Int) -> Unit) {
    if (iterator == null) return
    while (iterator.hasNext()) {
      val prefix = iterator.next()
      action(prefix.address(), prefix.prefix())
    }
  }

  private fun forEachString(iterator: StringIterator?, action: (String) -> Unit) {
    if (iterator == null) return
    while (iterator.hasNext()) action(iterator.next())
  }

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
    val coreless = intent?.getBooleanExtra("coreless", false) == true
    val relays = intent?.getStringExtra("relays").orEmpty()
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

    val psk = CoreConfig.readPsk(this)
    if (psk.isBlank()) throw IllegalStateException("no PSK: put it in files/psk.txt or the settings screen")

    val port = if (coreless) {
      Log.w(TAG, "started without the core (engine only)")
      0
    } else {
      val started = Mobile.start(
        CoreConfig.json(psk, CoreConfig.splitList(bootstrap), CoreConfig.splitList(relays)),
      ).toInt()
      Log.i(TAG, "core listening on 127.0.0.1:$started")
      started
    }

    val setup = SetupOptions()
    setup.setBasePath(filesDir.absolutePath)
    setup.setWorkingPath(filesDir.absolutePath)
    setup.setTempPath(cacheDir.absolutePath)
    Libbox.setup(setup)

    val commandServer = Libbox.newCommandServer(MgCommandHandler(), MgPlatformInterface(this))
    commandServer.start()
    commandServer.startOrReloadService(SingBoxConfig.build(port, coreless), OverrideOptions())
    server = commandServer
    running = true
    Log.i(TAG, "tunnel up (engine ${Libbox.version()}, core $port)")
    notify(notification("connected"))
  }

  internal fun stopTunnel() {
    if (!running && server == null) return
    running = false
    try {
      server?.closeService()
      server?.close()
    } catch (error: Throwable) {
      Log.w(TAG, "closing the engine: ${error.message}")
    }
    server = null
    Mobile.stop()
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
