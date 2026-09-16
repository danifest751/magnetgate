package ai.magnetgate.client

import org.json.JSONArray
import org.json.JSONObject

/**
 * The sing-box configuration the app runs: everything goes into the tunnel and out through the core.
 *
 * The core already knows how to reach an exit - it discovered one over the DHT or over Nostr - and it
 * exposes that as a SOCKS listener on loopback. So the engine needs exactly one outbound of its own: a
 * SOCKS client pointed at the core. Which means the routing policy of the phone client lives in the
 * core (which node, which plane, what is paused), and this file only describes the tunnel itself.
 *
 * Addresses here are the ones the platform hands to VpnService (see PlatformInterface.openTun): they
 * have to agree with what the tun inbound declares, and sing-box passes them straight through.
 */
object SingBoxConfig {
  const val TUN_ADDRESS_V4 = "172.19.0.1/30"

  fun build(socksPort: Int, coreless: Boolean = false): String {
    val config = JSONObject()

    config.put(
      "log",
      JSONObject()
        .put("level", "warn")
        .put("timestamp", true),
    )

    // DNS goes through the tunnel as well; auto_route hijacks port 53 into the tun, so the resolver
    // below is what actually answers.
    config.put(
      "dns",
      JSONObject()
        .put(
          "servers",
          JSONArray().put(
            JSONObject()
              .put("type", "udp")
              .put("tag", "remote")
              .put("server", "1.1.1.1")
              .apply { if (!coreless) put("detour", "core") },
          ),
        )
        .put("final", "remote"),
    )

    config.put(
      "inbounds",
      JSONArray().put(
        JSONObject()
          .put("type", "tun")
          .put("tag", "tun")
          .put("address", JSONArray().put(TUN_ADDRESS_V4))
          .put("mtu", 1500)
          .put("auto_route", true)
          .put("strict_route", false)
          // a userspace stack: no kernel module, no root, and it is what libbox is being used for
          .put("stack", "gvisor"),
      ),
    )

    // without the core there is nothing to tunnel through; the engine is then only a tun with a direct    // outbound, which is what the two-runtime experiment needs to be meaningful
    config.put(
      "outbounds",
      if (coreless) {
        JSONArray().put(JSONObject().put("type", "direct").put("tag", "core"))
      } else {
        JSONArray()
          .put(
            JSONObject()
              .put("type", "socks")
              .put("tag", "core")
              .put("server", "127.0.0.1")
              .put("server_port", socksPort),
          )
          .put(JSONObject().put("type", "direct").put("tag", "direct"))
      },
    )

    config.put(
      "route",
      JSONObject()
        .put("rules", JSONArray())
        .put("final", "core")
        .put("auto_detect_interface", true),
    )

    return config.toString(2)
  }
}
