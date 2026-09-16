package ai.magnetgate.client

import ai.magnetgate.core.mgbox.PlatformHandler
import android.net.ConnectivityManager
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress

/**
 * What the engine asks the platform for: a tunnel, socket protection, and who owns a connection.
 *
 * Everything else the engine can ask for is answered inside the binding with an explicit default, so the
 * app carries no boilerplate for features it does not offer. The tun itself is built by the service (only
 * a VpnService may configure one) from the request the engine sends.
 */
class MgTunPlatform(private val service: MgVpnService) : PlatformHandler {

  /** The request is the JSON form of the engine's tun options. */
  override fun openTun(requestJson: String): Int = service.establishTun(JSONObject(requestJson))

  /** Called for each of the engine's own sockets, so they leave the device instead of looping back. */
  override fun protect(fd: Int) {
    if (!service.protect(fd)) {
      throw IllegalStateException("VpnService.protect($fd) failed")
    }
  }

  /**
   * Who owns a connection, which the engine needs for per-app rules and for its connection list.
   *
   * Android can only answer this from API 29, and it refuses when the socket belongs to nobody it knows -
   * both cases are reported as an error, which the engine treats as "unknown" rather than failing.
   */
  override fun findConnectionOwner(
    protocol: Long,
    sourceAddress: String,
    sourcePort: Long,
    destinationAddress: String,
    destinationPort: Long,
  ): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      throw UnsupportedOperationException("connection owner lookup needs Android 10")
    }
    val connectivity = service.getSystemService(ConnectivityManager::class.java)
      ?: throw IllegalStateException("no connectivity service")
    val uid = connectivity.getConnectionOwnerUid(
      protocol.toInt(),
      InetSocketAddress(sourceAddress, sourcePort.toInt()),
      InetSocketAddress(destinationAddress, destinationPort.toInt()),
    )
    if (uid < 0) throw IllegalStateException("no owner for $destinationAddress:$destinationPort")
    val packages = service.packageManager.getPackagesForUid(uid) ?: emptyArray()
    Log.d(MgVpnService.TAG, "connection owner of $destinationAddress:$destinationPort is uid $uid ${packages.joinToString()}")
    return JSONObject()
      .put("userId", uid)
      .put("userName", packages.firstOrNull() ?: "")
      .put("processPath", "")
      .put("androidPackageNames", JSONArray(packages.toList()))
      .toString()
  }
}
