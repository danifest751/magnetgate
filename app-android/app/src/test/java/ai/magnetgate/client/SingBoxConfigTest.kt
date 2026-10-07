package ai.magnetgate.client

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class SingBoxConfigTest {
  @Test fun publicAccessCarriesBothTcpAndUdpWithoutPskOrNativeCore() {
    val config = JSONObject(SingBoxConfig.build(0, false, listOf(node(0), node(1)), publicRoute = true).json)
    val outbounds = config.getJSONArray("outbounds")
    val items = (0 until outbounds.length()).map { outbounds.getJSONObject(it) }
    assertEquals("urltest", items.single { it.getString("tag") == "core" }.getString("type"))
    assertFalse(items.any { it.optString("type") == "socks" })
    assertEquals("udp-proxy", rules(config).single { it.optString("network") == "udp" }.getString("outbound"))
    assertEquals("core", config.getJSONObject("route").getString("final"))
  }
  @Test fun peerGuestUsesAuthenticatedLoopbackAndRejectsUdpAfterDnsWithoutServerFallback() {
    val endpoint = JSONObject().put("port", 12080).put("username", "a".repeat(48)).put("password", "b".repeat(48))
    val config = JSONObject(SingBoxConfig.build(12080, false, peerEndpoint = endpoint).json)
    val outbound = config.getJSONArray("outbounds").getJSONObject(0)
    assertEquals("socks", outbound.getString("type"))
    assertEquals(endpoint.getString("password"), outbound.getString("password"))
    val routes = rules(config)
    val dns = routes.indexOfFirst { it.optString("action") == "hijack-dns" }
    val udp = routes.indexOfFirst { it.optString("network") == "udp" }
    assertTrue(dns >= 0 && udp > dns)
    assertEquals("reject", routes[udp].getString("action"))
    assertEquals("core", config.getJSONObject("route").getString("final"))
  }
  @Test fun udpRanksPreferredCountryFirstAndRetainsOtherCountriesForFailure() {
    val nodes = listOf(node(0).copy(country = "NL"), node(1).copy(country = "FI"))
    fun tags(country: String, nodes: List<DiscoveredNode>): List<String> {
      val config = JSONObject(SingBoxConfig.build(1080, false, nodes, country = country).json)
      val outbounds = config.getJSONArray("outbounds")
      val group = (0 until outbounds.length()).map { outbounds.getJSONObject(it) }
        .firstOrNull { it.optString("tag") == "udp-proxy" } ?: return emptyList()
      val tags = group.getJSONArray("outbounds")
      return (0 until tags.length()).map { tags.getString(it) }
    }
    assertEquals(listOf("exit-0-hy2", "exit-1-hy2"), tags("NL", nodes))
    assertEquals(listOf("exit-1-hy2", "exit-0-hy2"), tags("FI", nodes))
    assertEquals(listOf("exit-0-hy2", "exit-1-hy2"), tags("DE", nodes))
    assertEquals(listOf("exit-1-hy2"), tags("NL", listOf(
      DiscoveredNode(0, emptyList(), "NL"), node(1).copy(country = "FI"))))
  }
  @Test fun udpCanUseRealityWhenQuicIsUnavailableAndKeepsExistingSessions() {
    val reality = JSONObject().put("t", "reality").put("host", "192.0.2.1").put("port", 443)
      .put("uuid", "a34c7c8b-9c81-4a12-90cf-b029437b3e4d").put("sni", "example.com")
      .put("pbk", "test-public-key").put("sid", "test-short-id")
    val config = JSONObject(SingBoxConfig.build(1080, false,
      listOf(DiscoveredNode(0, listOf(reality), "NL")), country = "NL").json)
    val outbounds = config.getJSONArray("outbounds")
    val group = (0 until outbounds.length()).map { outbounds.getJSONObject(it) }
      .single { it.optString("tag") == "udp-proxy" }
    assertEquals("exit-0-reality", group.getJSONArray("outbounds").getString(0))
    assertFalse(group.getBoolean("interrupt_exist_connections"))
    assertEquals("udp-proxy", rules(config).single { it.optString("network") == "udp" }.getString("outbound"))
  }
  private fun node(slot: Int) = DiscoveredNode(slot, listOf(JSONObject()
    .put("t", "hy2").put("host", "192.0.2.${slot + 1}").put("port", 443)
    .put("pw", "test-password").put("obfs", "test-obfs").put("sni", "magnetgate")
    .put("ca", javaClass.getResourceAsStream("/udp-test-cert.crt")!!.bufferedReader().use { it.readText() })))

  private fun rules(config: JSONObject): List<JSONObject> {
    val array = config.getJSONObject("route").getJSONArray("rules")
    return (0 until array.length()).map { array.getJSONObject(it) }
  }

  @Test fun fullModeRoutesAllUdpThroughAvailableNodesAfterDirectExceptions() {
    val config = JSONObject(SingBoxConfig.build(1080, false, listOf(node(0), node(1)),
      directDomains = listOf("direct.test")).json)
    val routes = rules(config)
    val udp = routes.indexOfFirst { it.optString("network") == "udp" }
    val direct = routes.indexOfFirst { it.has("domain_suffix") }
    val private = routes.indexOfFirst { it.optBoolean("ip_is_private") }
    assertTrue(udp > direct && udp > private)
    assertFalse(routes[udp].has("port"))
    assertEquals("udp-proxy", routes[udp].getString("outbound"))
    val outbounds = config.getJSONArray("outbounds")
    val group = (0 until outbounds.length()).map { outbounds.getJSONObject(it) }
      .single { it.optString("tag") == "udp-proxy" }
    assertEquals("urltest", group.getString("type"))
    assertEquals(listOf("exit-0-hy2", "exit-1-hy2"),
      (0 until group.getJSONArray("outbounds").length()).map { group.getJSONArray("outbounds").getString(it) })
  }

  @Test fun splitModeUsesUdpTunnelForEachSelectedDestinationAndKeepsOtherTrafficDirect() {
    val config = JSONObject(SingBoxConfig.build(1080, false, listOf(node(0)), mode = Settings.Mode.SPLIT,
      tunnelDomains = listOf("tunnel.test"), ruleSets = listOf(RuleSets.Available("blocked", "/test.srs"))).json)
    val routes = rules(config)
    for (field in listOf("domain_suffix", "rule_set")) {
      val matches = routes.filter { it.has(field) }
      assertEquals(2, matches.size)
      assertEquals("udp", matches[0].getString("network"))
      assertEquals("udp-proxy", matches[0].getString("outbound"))
      assertEquals("core", matches[1].getString("outbound"))
    }
    assertEquals("direct", config.getJSONObject("route").getString("final"))
    assertFalse(routes.any { it.optString("network") == "udp" && !it.has("domain_suffix") && !it.has("rule_set") })
  }

  @Test fun missingUdpTransportRejectsDatagramsWithoutBypassingVpn() {
    for (mode in Settings.Mode.entries) {
      val config = JSONObject(SingBoxConfig.build(1080, false, mode = mode,
        tunnelDomains = listOf("tunnel.test")).json)
      val udp = rules(config).filter { it.optString("network") == "udp" }
      assertTrue(udp.isNotEmpty())
      assertTrue(udp.all { it.optString("action") == "reject" && !it.has("outbound") })
    }
  }

  @Test fun generatedConfigsAreAcceptedByPinnedEngine() {
    val root = generateSequence(File(System.getProperty("user.dir")!!)) { it.parentFile }
      .firstOrNull { File(it, "tools/sing-box/sing-box.exe").exists() }
    org.junit.Assume.assumeTrue("Install the pinned engine with scripts/get-singbox.ps1", root != null)
    for (mode in Settings.Mode.entries) for (nodes in listOf(emptyList(), listOf(node(0), node(1)))) {
      val config = SingBoxConfig.build(1080, false, nodes, mode = mode,
        directDomains = listOf("direct.test"), tunnelDomains = listOf("tunnel.test"))
      val file = File.createTempFile("magnetgate-config-", ".json")
      try {
        file.writeText(config.json)
        val process = ProcessBuilder(File(root, "tools/sing-box/sing-box.exe").absolutePath,
          "check", "-c", file.absolutePath).redirectErrorStream(true).start()
        val finished = process.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)
        if (!finished) process.destroyForcibly()
        assertTrue(finished)
        assertEquals(process.inputStream.bufferedReader().readText(), 0, process.exitValue())
      } finally { file.delete() }
    }
  }

  @Test fun internalSocksDoesNotAcknowledgeAnUnreachableDestination() {
    val root = generateSequence(File(System.getProperty("user.dir")!!)) { it.parentFile }
      .firstOrNull { File(it, "tools/sing-box/sing-box.exe").exists() }
    org.junit.Assume.assumeTrue("Install the pinned engine with scripts/get-singbox.ps1", root != null)
    val built = SingBoxConfig.build(1080, false, listOf(node(0)))
    val config = JSONObject(built.json)
    val inbounds = config.getJSONArray("inbounds")
    inbounds.remove(0) // Run the actual loopback plane, without requiring a Windows tun driver.
    val outbounds = config.getJSONArray("outbounds")
    for (i in 0 until outbounds.length()) {
      when (outbounds.getJSONObject(i).optString("tag")) {
        "exit-0-hy2" -> outbounds.put(i, JSONObject().put("type", "direct").put("tag", "exit-0-hy2"))
        "udp-proxy" -> outbounds.put(i, JSONObject().put("type", "selector").put("tag", "udp-proxy")
          .put("outbounds", org.json.JSONArray().put("exit-0-hy2")))
      }
    }
    val file = File.createTempFile("magnetgate-handshake-", ".json")
    val log = File.createTempFile("magnetgate-handshake-", ".log")
    file.writeText(config.toString())
    val engine = ProcessBuilder(File(root, "tools/sing-box/sing-box.exe").absolutePath,
      "run", "-c", file.absolutePath).redirectErrorStream(true).redirectOutput(log).start()
    try {
      val limit = System.nanoTime() + 5_000_000_000L
      var socket: java.net.Socket? = null
      while (socket == null && System.nanoTime() < limit && engine.isAlive) {
        socket = runCatching { java.net.Socket("127.0.0.1", built.planes.single().port) }.getOrNull()
        if (socket == null) Thread.sleep(30)
      }
      assertNotNull(log.readText(), socket)
      socket!!.use {
        it.soTimeout = 2_000
        val input = it.getInputStream()
        val output = it.getOutputStream()
        output.write(byteArrayOf(5, 1, 0)); output.flush()
        assertEquals(5, input.read()); assertEquals(0, input.read())
        val unreachable = java.net.ServerSocket(0).use { server -> server.localPort }
        output.write(byteArrayOf(5, 1, 0, 1, 127, 0, 0, 1,
          (unreachable shr 8).toByte(), unreachable.toByte())); output.flush()
        val version = input.read()
        assertTrue("SOCKS claimed success before dialing an unreachable target",
          version == -1 || input.read() != 0)
      }
    } finally {
      engine.destroy()
      if (!engine.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) engine.destroyForcibly()
      file.delete(); log.delete()
    }
  }
}
