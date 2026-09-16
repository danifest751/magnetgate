package ai.magnetgate.client

import android.util.Log
import io.nekohasekai.libbox.BridgeOptions
import io.nekohasekai.libbox.BridgeSession
import io.nekohasekai.libbox.ConnectionOwner
import io.nekohasekai.libbox.InterfaceUpdateListener
import io.nekohasekai.libbox.LocalDNSTransport
import io.nekohasekai.libbox.NeighborUpdateListener
import io.nekohasekai.libbox.NetworkInterfaceIterator
import io.nekohasekai.libbox.PlatformInterface
import io.nekohasekai.libbox.PlatformUser
import io.nekohasekai.libbox.ShellSession
import io.nekohasekai.libbox.StringIterator
import io.nekohasekai.libbox.TunOptions
import io.nekohasekai.libbox.WIFIState

/**
 * What the engine needs from the host platform.
 *
 * Two methods carry the weight:
 *  - openTun builds the VpnService tunnel from what the engine asks for and hands back its descriptor;
 *  - autoDetectInterfaceControl marks a socket as belonging to this app, so the engine's own traffic
 *    leaves the device instead of being fed back into the tunnel it just created.
 *
 * Everything else is either a feature this client does not use (shell, bridge, SSH, Tailscale) or
 * optional reporting, and says so explicitly rather than pretending.
 */
class MgPlatformInterface(private val service: MgVpnService) : PlatformInterface {

  override fun openTun(options: TunOptions): Int = service.establishTun(options)

  /** Called by the engine for each socket it opens; without it those sockets would loop into the tun. */
  override fun autoDetectInterfaceControl(fd: Int) {
    if (!service.protect(fd)) {
      throw IllegalStateException("VpnService.protect($fd) failed")
    }
  }

  override fun usePlatformAutoDetectInterfaceControl(): Boolean = true

  override fun includeAllNetworks(): Boolean = false

  override fun localDNSTransport(): LocalDNSTransport? = null

  override fun clearDNSCache() = Unit

  override fun registerMyInterface(name: String) = Unit

  override fun readWIFIState(): WIFIState? = null

  override fun underNetworkExtension(): Boolean = false

  override fun useProcFS(): Boolean = false

  /**
   * Per-app routing needs the owner of each connection. Returning nothing means the engine cannot map
   * a connection to an app, so rules by package are not available yet; nothing else depends on it.
   */
  override fun findConnectionOwner(
    ipProtocol: Int,
    sourceAddress: String,
    sourcePort: Int,
    destinationAddress: String,
    destinationPort: Int,
  ): ConnectionOwner? = null

  override fun getInterfaces(): NetworkInterfaceIterator? = null

  override fun startDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
    // Interface changes are not tracked yet; the engine falls back to auto-detection.
  }

  override fun closeDefaultInterfaceMonitor(listener: InterfaceUpdateListener) = Unit

  override fun startNeighborMonitor(listener: NeighborUpdateListener) {
    throw UnsupportedOperationException("neighbour monitoring is not used")
  }

  override fun closeNeighborMonitor(listener: NeighborUpdateListener) = Unit

  override fun sendNotification(notification: io.nekohasekai.libbox.Notification) {
    throw UnsupportedOperationException("notifications are not used")
  }

  override fun cancelNotification(identifier: String, typeID: Int) = Unit

  override fun usePlatformShell(): Boolean = false

  override fun checkPlatformShell() {
    throw UnsupportedOperationException("shell sessions are not used")
  }

  override fun openShellSession(
    user: PlatformUser?,
    command: String,
    environ: StringIterator?,
    term: String,
    rows: Int,
    cols: Int,
  ): ShellSession {
    throw UnsupportedOperationException("shell sessions are not used")
  }

  override fun lookupUser(username: String): PlatformUser? = null

  override fun lookupSFTPServer(): String? = null

  override fun readSystemSSHHostKey(): String? = null

  override fun tailscaleHostname(): String = ""

  override fun usePlatformBridge(): Boolean = false

  override fun createBridge(options: BridgeOptions): BridgeSession {
    throw UnsupportedOperationException("bridges are not used")
  }
}
