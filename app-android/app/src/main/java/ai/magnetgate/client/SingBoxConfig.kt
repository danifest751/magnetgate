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

  /**
   * The tun needs an IPv6 address even though nothing is carried over IPv6, and this is the whole
   * point: without one the platform adds no `::/0` route, so IPv6 traffic never enters the tunnel and
   * leaves the device directly. In full mode that is a silent leak - the user believes everything is
   * tunnelled while every IPv6-capable destination is reached in the clear. Claiming the route and then
   * rejecting the traffic (see the ip_version rule below) makes applications fall back to IPv4 instead,
   * which is what the desktop has always done.
   */
  const val TUN_ADDRESS_V6 = "fdfe:dcba:9876::1/126"

  /** The inbound the health check dials, named so the rules that single it out read plainly. */
  private const val CHECK_INBOUND = "in-health-check"

  /**
   * The configuration, the plane-to-port mapping the core has to be told about, and the loopback port
   * the health check goes through. [checkPort] is 0 when there is no engine path to check.
   */
  data class Built(val json: String, val planes: List<EnginePlane>, val checkPort: Int = 0)

  fun build(
    socksPort: Int,
    coreless: Boolean,
    nodes: List<DiscoveredNode> = emptyList(),
    excludePackages: List<String> = emptyList(),
    mode: Settings.Mode = Settings.Mode.FULL,
    directDomains: List<String> = emptyList(),
    tunnelDomains: List<String> = emptyList(),
    ruleSets: List<RuleSets.Available> = emptyList(),
    // Where the engine writes its own log, or empty for the log it has always had: a level the app
    // never reads. Without it a reset connection has no explanation anywhere - the core's log ends at
    // "stream opened", and the engine's side of the tunnel is silent (trap 80).
    logPath: String = "",
    // What the engine writes while this tunnel runs. `info` is one line per connection, which is what
    // explains a reset; `debug` adds what the sniffer read and how a route was chosen, which is the only
    // way to see where a connection waits before the core is dialled. Debug is for a hunt, not for every
    // day: it is several times the volume, and it names the domains this phone visits.
    logLevel: String = "info",
    // An acceptance hook, and only ever set by one: the slot whose exits are pointed at an address that
    // answers nothing, so that a dead path can be produced on demand without touching a live node.
    //
    // It exists because the failure that matters here cannot be simulated at any smaller scale. A plane
    // whose open succeeds and whose stream then carries nothing is invisible to everything except the
    // stream itself (health.JudgeFirstByte), so proving that the client leaves such a path needs the
    // real chain - core, engine, reality - with one real exit replaced by a black hole. -1 is off.
    brokenSlot: Int = -1,
    // What the package list means: the apps that stay out of the tunnel, or the only ones allowed into
    // it. The engine has both options and the platform turns them into addDisallowedApplication or
    // addAllowedApplication; the difference matters to a person who wants one messenger tunnelled and
    // their bank left alone. Last in the list because the callers pass these positionally.
    appsMode: Settings.Apps = Settings.Apps.EXCEPT,
  ): Built {
    val outbounds = JSONArray()
    val planeInbounds = JSONArray()
    val rules = JSONArray()
    val planes = mutableListOf<EnginePlane>()

    // These two come first, before anything is routed anywhere, exactly as in app/vpn-config.cjs.
    //
    // sniff reads the destination name out of the TLS handshake or the HTTP request. Without it a rule
    // that names a domain never matches a connection an application made to an address it resolved
    // itself - which is most of them - so the whole site-rule policy below would only half apply.
    //
    // hijack-dns takes DNS asked of any server and answers it from the resolver configured above.
    // Without it an application that dials a fixed resolver (8.8.8.8 is common, and Android's private
    // DNS is another) never reaches ours: its queries leave as ordinary traffic, visible to whoever
    // carries them, and resolve outside every rule we set.
    rules.put(JSONObject().put("action", "sniff"))
    rules.put(JSONObject().put("protocol", "dns").put("action", "hijack-dns"))

    for (node in nodes) {
      for (plane in node.planes) {
        val type = plane.optString("t")
        if (type != "reality" && type != "hy2") continue // the core speaks the rest itself
        val outbound = transportOutbound(plane) ?: continue
        val tag = "exit-${node.slot}-$type"
        // TEST-NET-3 (RFC 5737): routed nowhere, so every dial through this plane opens, waits and dies -
        // which is exactly what a node whose reality endpoint has stopped answering looks like from here.
        if (node.slot == brokenSlot) outbound.put("server", "203.0.113.1")
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
        .put("server_port", socksPort)
        // The core answers on loopback, so this is not about the network: it is the bound on how long a
        // request may sit inside the core while it works through its planes. Past it the caller is told,
        // rather than left to a browser's own patience.
        .put("connect_timeout", CORE_TIMEOUT),
    )
    outbounds.put(JSONObject().put("type", "direct").put("tag", "direct"))

    val tun = JSONObject()
      .put("type", "tun")
      .put("tag", "tun")
      .put("address", JSONArray().put(TUN_ADDRESS_V4).put(TUN_ADDRESS_V6))
      // 1400, the same as the desktop (app/vpn-config.cjs). A full 1500 leaves no room for what the
      // data plane wraps around it - reality adds TLS and TCP headers - so the outer packet exceeds the
      // path MTU and is dropped. Small packets still pass, which is why a connection opens and then
      // delivers nothing: on a phone this looked like "the tunnel is up and the internet is dead".
      .put("mtu", 1400)
      .put("auto_route", true)
      .put("strict_route", false)
      // a userspace stack: no kernel module, no root, and it is what libbox is being used for
      .put("stack", "gvisor")
      .apply {
        // The engine passes these to the platform, which turns them into addDisallowedApplication (an
        // excluded app keeps using the normal network) or addAllowedApplication (nothing else enters
        // the tunnel at all). An empty list means neither: "only these apps, and there are none" would
        // be a tunnel that carries nothing, which is never what an empty list was meant to say.
        if (excludePackages.isNotEmpty()) {
          val key = if (appsMode == Settings.Apps.ONLY) "include_package" else "exclude_package"
          put(key, JSONArray(excludePackages))
        }
      }
    val inbounds = JSONArray().put(tun)
    for (index in 0 until planeInbounds.length()) inbounds.put(planeInbounds.get(index))

    val config = JSONObject()
    // `info` rather than `warn` when a file is asked for: a connection the engine resets is reported at
    // info, and that is the line the owner's "connection reset" evening had nothing to show for.
    val level = if (logPath.isEmpty()) "warn" else logLevel
    val log = JSONObject().put("level", level).put("timestamp", true)
    if (logPath.isNotEmpty()) log.put("output", logPath)
    config.put("log", log)
    config.put(
      "dns",
      JSONObject()
        .put(
          "servers",
          JSONArray().put(
            JSONObject()
              // DNS-over-HTTPS, not plain UDP: the core's SOCKS entry point answers CONNECT and refuses
              // UDP ASSOCIATE on purpose (the Android data plane is TCP), so a UDP resolver pointed
              // through it could never work. DoH is TCP, so it goes through the same path the traffic
              // does - and the query is encrypted twice over rather than readable on the way out.
              .put("type", "https")
              .put("tag", "remote")
              .put("server", "1.1.1.1")
              .apply { if (!coreless) put("detour", "core") },
          ),
        )
        // Resolve A records only. Every endpoint a node advertises is IPv4 and IPv6 is rejected by the
        // rule below, so handing an application a AAAA record gives it an address that cannot be used:
        // it tries, waits for the rejection, then falls back - which reads as "pages load strangely"
        // while something like Telegram, which dials fixed IPv4 addresses, stays perfectly fast.
        .put("strategy", "ipv4_only")
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
    // Rejected, not routed: every endpoint a node advertises is IPv4, so an IPv6 destination has
    // nowhere to go through the tunnel. Rejecting it makes an application fall back to IPv4 at once,
    // while letting it out would be the leak the tun's IPv6 address exists to prevent. This sits ahead
    // of the mode rules so neither mode can send it anywhere.
    // ---- the health check's own way in -------------------------------------------------------------
    //
    // The app is excluded from its own VPN, so nothing it sends travels the path its user's traffic
    // does, and a check through the core's SOCKS proves only that the exit carries bytes. The DNS
    // regress of 17.09 broke none of that: it broke resolution, and every check the app had stayed
    // green through it.
    //
    // This listener closes that gap. `resolve` makes the engine resolve the destination name itself,
    // with the resolver and the strategy configured above - so a resolver that cannot work (a UDP one
    // behind a SOCKS entry that refuses UDP), or one handing back AAAA records that the rule below
    // rejects, fails the check instead of quietly costing the user their afternoon.
    val checkPort = if (coreless) 0 else freePort()
    if (checkPort != 0) {
      // straight into `inbounds`: the plane list was copied into it further up, and adding to that list
      // here would leave this listener out of the configuration without a word
      inbounds.put(
        JSONObject()
          .put("type", "socks")
          .put("tag", CHECK_INBOUND)
          .put("listen", "127.0.0.1")
          .put("listen_port", checkPort),
      )
      rules.put(JSONObject().put("inbound", JSONArray().put(CHECK_INBOUND)).put("action", "resolve"))
    }

    rules.put(JSONObject().put("ip_version", 6).put("action", "reject"))

    // After the reject, deliberately: an address family the tunnel cannot carry must fail this check the
    // same way it fails an application, rather than being routed around by a rule written for the check.
    if (checkPort != 0) {
      rules.put(JSONObject().put("inbound", JSONArray().put(CHECK_INBOUND)).put("outbound", "core"))
    }

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
        // Off, and deliberately: the engine's sockets are kept on the right network by the platform
        // (AutoDetectInterfaceControl -> VpnService.protect), and an application on Android may not bind
        // a socket to an interface by index. Turning this on stopped the traffic dead - the tunnel came
        // up with every plane and the exit check answered `connection closed` (measured 18.09).
        //
        // What the engine does now get is the news: MgVpnService.watchNetwork reports Android's current
        // network through Mgbox.updateDefaultInterface, so a change refreshes sing-box's view instead of
        // leaving it with whatever it saw at startup.
        .put("auto_detect_interface", false)
        // Which resolver the routing rules themselves use when a rule names a domain. Without it a
        // domain rule resolves through whatever the platform would have used, which is the network's
        // own resolver - outside the tunnel, and visible to it.
        .put("default_domain_resolver", "remote"),
    )
    return Built(config.toString(2), planes, checkPort)
  }

  /**
   * Mirrors src/transport-config.cjs: what a node's data-plane entry means as a sing-box outbound. Nothing
   * here weakens TLS verification - the certificate is pinned where the entry carries one.
   */
  /**
   * How long the engine may spend opening one connection to an exit.
   *
   * sing-box's own default let a degraded path hold a connection for 15 to 18 seconds (measured in the
   * engine log on 17.09) while the browser above gave up after three and showed a reset connection. The
   * core's pool bounds its attempt at 4s (pool.DefaultOpenTimeout) and moves to the next plane; the
   * engine must not sit past that, or the bound means nothing.
   */
  private const val CONNECT_TIMEOUT = "5s"

  /**
   * How long one request may spend inside the core. The pool tries the planes of every node in turn,
   * each bounded by pool.DefaultOpenTimeout, so this is deliberately larger than one attempt and still
   * smaller than the patience of the application above.
   */
  private const val CORE_TIMEOUT = "10s"

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
          .put("connect_timeout", CONNECT_TIMEOUT)
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
          .put("connect_timeout", CONNECT_TIMEOUT)
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
