package ai.magnetgate.client

import org.json.JSONArray
import org.json.JSONObject
import java.net.ServerSocket

/** One plane the engine carries for the core: a node's slot, the plane type and the loopback port. */
data class EnginePlane(val slot: Int, val plane: String, val port: Int)

/** A node as the core reports it: its slot and the transports it advertises. */
data class DiscoveredNode(val slot: Int, val planes: List<JSONObject>)

/**
 * The sing-box configuration the app runs: everything goes into the tunnel and out through one of the
 * planes the core can use.
 *
 * The core speaks the native mux itself and tells the engine where to send anything else: for every node
 * and every plane the core cannot speak (reality, hysteria2) this file adds an outbound and a loopback
 * SOCKS listener of its own, plus the rule that ties them together. The core then dials that listener and
 * gets the node's plane - the engine holds the transport details, the core only holds a port number.
 */
object SingBoxConfig {
  const val TUN_ADDRESS_V4 = "172.19.0.1/30"

  /** The configuration, and the plane-to-port mapping the core has to be told about. */
  data class Built(val json: String, val planes: List<EnginePlane>)

  fun build(
    socksPort: Int,
    coreless: Boolean,
    nodes: List<DiscoveredNode> = emptyList(),
    excludePackages: List<String> = emptyList(),
    mode: Settings.Mode = Settings.Mode.FULL,
    directDomains: List<String> = emptyList(),
    tunnelDomains: List<String> = emptyList(),
    ruleSets: List<RuleSets.Available> = emptyList(),
  ): Built {
    val outbounds = JSONArray()
    val planeInbounds = JSONArray()
    val rules = JSONArray()
    val planes = mutableListOf<EnginePlane>()

    for (node in nodes) {
      for (plane in node.planes) {
        val type = plane.optString("t")
        if (type != "reality" && type != "hy2") continue // the core speaks the rest itself
        val outbound = transportOutbound(plane) ?: continue
        val tag = "exit-${node.slot}-$type"
        outbound.put("tag", tag)
        outbounds.put(outbound)

        // the core reaches that plane through this listener, and only this listener
        val port = freePort()
        val inbound = "in-${node.slot}-$type"
        planeInbounds.put(
          JSONObject()
            .put("type", "socks")
            .put("tag", inbound)
            .put("listen", "127.0.0.1")
            .put("listen_port", port),
        )
        rules.put(JSONObject().put("inbound", JSONArray().put(inbound)).put("outbound", tag))
        planes.add(EnginePlane(node.slot, type, port))
      }
    }

    outbounds.put(
      JSONObject()
        .put("type", "socks")
        .put("tag", "core")
        .put("server", "127.0.0.1")
        .put("server_port", socksPort),
    )
    outbounds.put(JSONObject().put("type", "direct").put("tag", "direct"))

    val tun = JSONObject()
      .put("type", "tun")
      .put("tag", "tun")
      .put("address", JSONArray().put(TUN_ADDRESS_V4))
      .put("mtu", 1500)
      .put("auto_route", true)
      .put("strict_route", false)
      // a userspace stack: no kernel module, no root, and it is what libbox is being used for
      .put("stack", "gvisor")
      .apply {
        // The engine passes these to the platform, which turns them into addDisallowedApplication: an
        // excluded app keeps using the normal network and never enters the tunnel.
        if (excludePackages.isNotEmpty()) put("exclude_package", JSONArray(excludePackages))
      }
    val inbounds = JSONArray().put(tun)
    for (index in 0 until planeInbounds.length()) inbounds.put(planeInbounds.get(index))

    val config = JSONObject()
    config.put("log", JSONObject().put("level", "warn").put("timestamp", true))
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
    // ---- routing policy, the same shape as the desktop's app/vpn-config.cjs -------------------------
    //
    // Everything above this point is plumbing: the per-plane rules that map each loopback listener to the
    // node it belongs to, and which must stay first so a plane's own traffic is never re-routed by the
    // rules below. What follows is the policy a user actually chooses.
    //
    // FULL  - the tunnel takes everything, and only the domains the user named go direct. A packaged
    //         list is never consulted here: a bundled file must not silently bypass the tunnel, whatever
    //         it is called. This is the safe default.
    // SPLIT - the tunnel takes what the rule-sets and the user's tunnel list name; the rest goes direct.
    val ruleSetDefs = JSONArray()
    if (mode == Settings.Mode.SPLIT) {
      for (set in ruleSets) {
        ruleSetDefs.put(
          JSONObject()
            .put("type", "local")
            .put("tag", set.tag)
            .put("format", "binary")
            .put("path", set.path),
        )
        rules.put(JSONObject().put("rule_set", JSONArray().put(set.tag)).put("outbound", "core"))
      }
      if (tunnelDomains.isNotEmpty())
        rules.put(JSONObject().put("domain_suffix", JSONArray(tunnelDomains)).put("outbound", "core"))
    } else if (directDomains.isNotEmpty()) {
      rules.put(JSONObject().put("domain_suffix", JSONArray(directDomains)).put("outbound", "direct"))
    }
    // A private address is the local network, never something an exit could reach for us.
    rules.put(JSONObject().put("ip_is_private", true).put("outbound", "direct"))

    config.put("inbounds", inbounds)
    config.put("outbounds", outbounds)
    config.put(
      "route",
      JSONObject()
        // per-plane rules first, so the core's own listener maps to the node it belongs to
        .put("rules", rules)
        .apply { if (ruleSetDefs.length() > 0) put("rule_set", ruleSetDefs) }
        // what nothing matched: in split mode that is the open internet, in full mode it is the tunnel
        .put("final", if (mode == Settings.Mode.SPLIT) "direct" else "core")
        .put("auto_detect_interface", false),
    )
    return Built(config.toString(2), planes)
  }

  /**
   * Mirrors src/transport-config.cjs: what a node's data-plane entry means as a sing-box outbound. Nothing
   * here weakens TLS verification - the certificate is pinned where the entry carries one.
   */
  fun transportOutbound(plane: JSONObject): JSONObject? {
    val host = plane.optString("host")
    val port = plane.optInt("port")
    if (host.isEmpty() || port !in 1..65535) return null
    return when (plane.optString("t")) {
      "reality" -> {
        val uuid = plane.optString("uuid")
        val sni = plane.optString("sni")
        val publicKey = plane.optString("pbk")
        val shortId = plane.optString("sid")
        if (uuid.isEmpty() || sni.isEmpty() || publicKey.isEmpty() || shortId.isEmpty()) return null
        JSONObject()
          .put("type", "vless")
          .put("server", host)
          .put("server_port", port)
          .put("uuid", uuid)
          .put("flow", "xtls-rprx-vision")
          .put(
            "tls",
            JSONObject()
              .put("enabled", true)
              .put("server_name", sni)
              .put("utls", JSONObject().put("enabled", true).put("fingerprint", plane.optString("fp", "chrome")))
              .put(
                "reality",
                JSONObject().put("enabled", true).put("public_key", publicKey).put("short_id", shortId),
              ),
          )
      }

      "hy2" -> {
        val password = plane.optString("pw")
        val obfs = plane.optString("obfs")
        val sni = plane.optString("sni")
        val certificates = plane.optJSONArray("ca")?.let { array ->
          (0 until array.length()).map { array.optString(it) }
        } ?: listOf(plane.optString("ca"))
        if (password.isEmpty() || obfs.isEmpty() || sni.isEmpty()) return null
        if (certificates.isEmpty() || certificates.any { !it.contains("-----BEGIN CERTIFICATE-----") }) return null
        JSONObject()
          .put("type", "hysteria2")
          .put("server", host)
          .put("server_port", port)
          .put("password", password)
          .put("obfs", JSONObject().put("type", "salamander").put("password", obfs))
          .put(
            "tls",
            JSONObject()
              .put("enabled", true)
              .put("alpn", JSONArray().put("h3"))
              .put("server_name", sni)
              .put("certificate", JSONArray(certificates)),
          )
      }

      else -> null
    }
  }

  /** A free loopback port for a plane's listener: taken now, bound by the engine when it starts. */
  private fun freePort(): Int = ServerSocket(0).use { it.localPort }
}
