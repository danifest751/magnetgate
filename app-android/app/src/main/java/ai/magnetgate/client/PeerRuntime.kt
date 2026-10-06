package ai.magnetgate.client

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import ai.magnetgate.core.mgbox.Mgbox
import ai.magnetgate.core.mgbox.PeerPlatform
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Guest and opt-in exit share one Go runtime, with socket-scoped physical binding. */
object PeerRuntime {
  @Volatile private var protector: VpnService? = null
  @Volatile internal var sharingRequested = false
  @Volatile internal var sharingError = false
  @Volatile private var vpnGate = false
  internal val sharingLock = Any()
  fun gateForVpn() { vpnGate = true }
  fun suspendForVpn() { synchronized(sharingLock) { Mgbox.suspendPeerExit() } }
  fun resumeAfterVpn() { vpnGate = false; synchronized(sharingLock) { if (sharingRequested) Mgbox.resumePeerExit() } }
  fun setPolicy(policy: JSONObject) { synchronized(sharingLock) { Mgbox.setPeerPolicy(policy.toString()) } }
  fun attach(service: VpnService?) { protector = service }
  fun configured(context: Context) = File(context.filesDir, "peer/service.json").isFile
  fun ensure(context: Context) {
    check(configured(context)) { "Peer service has not been provisioned" }
    Mgbox.startPeer(File(context.filesDir, "peer").absolutePath, PhysicalLink(context.applicationContext))
  }
  fun status(): JSONObject = runCatching { JSONObject(Mgbox.peerStatus()) }.getOrDefault(JSONObject())
    .put("sharingRequested", sharingRequested).put("sharingError", sharingError)
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

  private class PhysicalLink(private val context: Context) : PeerPlatform {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private val power = context.getSystemService(PowerManager::class.java)
    private fun physical(): Network {
      val candidates = listOfNotNull(manager.activeNetwork) + manager.allNetworks.toList()
      return candidates.firstOrNull { network -> manager.getNetworkCapabilities(network)?.let {
        it.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) &&
          it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
          it.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
      } == true } ?: error("No validated physical network")
    }
    private fun generation(network: Network): String {
      val links = manager.getLinkProperties(network) ?: error("Physical network properties unavailable")
      val values = links.linkAddresses.map { it.toString() } + links.routes.map { it.toString() } +
        links.dnsServers.map { it.hostAddress.orEmpty() }
      // Include properties, not just a handle: the same Network can change subnet.
      return network.networkHandle.toString() + ":" + values.sorted().joinToString(";")
    }
    override fun state(): String {
      val network = physical()
      val token = generation(network)
      val prefixes = mutableSetOf<String>()
      val addresses = mutableSetOf<String>()
      var vpn = false
      for (candidate in manager.allNetworks) {
        val caps = manager.getNetworkCapabilities(candidate) ?: continue
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) { vpn = true; continue }
        val links = manager.getLinkProperties(candidate) ?: continue
        for (address in links.linkAddresses) {
          address.address.hostAddress?.substringBefore('%')?.let { addresses.add(it) }
          if (address.prefixLength > 0) prefixes.add(address.address.hostAddress!!.substringBefore('%') + "/" + address.prefixLength)
        }
        for (route in links.routes) {
          // /0 is internet reachability, never an on-link deny prefix.
          if (route.gateway?.isAnyLocalAddress != false && route.destination.prefixLength > 0) prefixes.add(route.destination.toString())
          route.gateway?.hostAddress?.substringBefore('%')?.let { addresses.add(it) }
        }
        links.dnsServers.mapNotNull { it.hostAddress?.substringBefore('%') }.forEach { addresses.add(it) }
      }
      check(physical() == network && generation(network) == token) { "Physical network changed" }
      val restricted = power.isDeviceIdleMode && !power.isIgnoringBatteryOptimizations(context.packageName)
      return JSONObject().put("generation", token)
        .put("allowed", sharingRequested && !vpnGate && !MgVpnService.ownsCore() && !vpn && !restricted)
        .put("prefixes", JSONArray(prefixes.sorted())).put("addresses", JSONArray(addresses.sorted())).toString()
    }
    override fun resolve(host: String): String {
      val network = physical()
      val token = generation(network)
      val addresses = network.getAllByName(host).mapNotNull { it.hostAddress }
      check(physical() == network && generation(network) == token) { "Network changed during lookup" }
      return JSONObject().put("generation", token).put("addresses", JSONArray(addresses)).toString()
    }
    override fun bind(fd: Long, generation: String) {
      val network = physical()
      check(generation(network) == generation) { "Physical network changed before dial" }
      ParcelFileDescriptor.fromFd(fd.toInt()).use { duplicate ->
        protector?.let { check(it.protect(duplicate.fd)) { "VPN socket protection failed" } }
        network.bindSocket(duplicate.fileDescriptor)
      }
      check(physical() == network && generation(network) == generation) { "Physical network changed while binding" }
    }
  }
}
