package ai.magnetgate.client

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.ParcelFileDescriptor
import ai.magnetgate.core.mgbox.Mgbox
import ai.magnetgate.core.mgbox.PeerPlatform
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** The guest core shares the existing Go runtime. Only service-link sockets are bound here. */
object PeerRuntime {
  @Volatile private var protector: VpnService? = null
  fun attach(service: VpnService?) { protector = service }
  fun configured(context: Context) = File(context.filesDir, "peer/service.json").isFile
  fun ensure(context: Context) {
    check(configured(context)) { "Peer service has not been provisioned" }
    Mgbox.startPeer(File(context.filesDir, "peer").absolutePath, PhysicalLink(context.applicationContext))
  }
  fun status(): JSONObject = runCatching { JSONObject(Mgbox.peerStatus()) }.getOrDefault(JSONObject())
  fun begin(token: String) { Mgbox.beginPeer(token) }
  fun connect(country: String, token: String): JSONObject {
    val deadline = System.nanoTime() + 5_000_000_000L
    while (!status().optBoolean("connected") && System.nanoTime() < deadline) Thread.sleep(50)
    check(status().optBoolean("connected")) { "Peer directory is unavailable" }
    return JSONObject(Mgbox.connectPeer(country, token))
  }
  fun disconnect() { Mgbox.disconnectPeer() }

  fun view(root: JSONObject): CoreStatus {
    val countries = root.optJSONArray("countries") ?: JSONArray()
    val rows = (0 until countries.length()).mapNotNull { index -> countries.optJSONObject(index)?.let { CountryRow(it.optString("cc"), it.optInt("nodes")) } }
    val guest = root.optBoolean("guestConnected")
    val cc = root.optString("guestCountry")
    return CoreStatus(running = guest, country = cc, countries = rows,
      sent = root.optLong("sent"), received = root.optLong("received"),
      nodes = if (guest) listOf(NodeRow(0, "Peer", "Peer", cc, listOf(Plane("peer", "")), emptyList())) else emptyList(),
      error = root.optString("error"))
  }

  private class PhysicalLink(context: Context) : PeerPlatform {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private fun physical(): Network {
      val candidates = listOfNotNull(manager.activeNetwork) + manager.allNetworks.toList()
      return candidates.firstOrNull { network -> manager.getNetworkCapabilities(network)?.let {
        it.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) &&
          it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
          it.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
      } == true } ?: error("No validated physical network")
    }
    override fun resolve(host: String): String {
      val network = physical()
      val addresses = network.getAllByName(host).map { it.hostAddress }.filterNotNull()
      check(physical() == network) { "Network changed during service lookup" }
      return JSONObject().put("generation", network.networkHandle.toString()).put("addresses", JSONArray(addresses)).toString()
    }
    override fun bind(fd: Long, generation: String) {
      val network = physical()
      check(network.networkHandle.toString() == generation) { "Physical network changed before dial" }
      ParcelFileDescriptor.fromFd(fd.toInt()).use { duplicate ->
        protector?.let { check(it.protect(duplicate.fd)) { "VPN socket protection failed" } }
        network.bindSocket(duplicate.fileDescriptor)
      }
      check(physical() == network) { "Physical network changed while binding" }
    }
  }
}
