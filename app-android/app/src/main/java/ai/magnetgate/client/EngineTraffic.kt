package ai.magnetgate.client

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/** Engine payload bytes, accumulated across recovery within one VPN session. */
internal class EngineTraffic {
  data class Totals(val sent: Long = 0, val received: Long = 0)
  data class Endpoint(val port: Int, val secret: String)
  @Volatile var totals = Totals()
    private set
  private var endpoint: Endpoint? = null
  private var previous = Totals()

  @Synchronized fun attach(port: Int, secret: String, newSession: Boolean = false) {
    endpoint = if (port > 0) Endpoint(port, secret) else null
    previous = Totals()
    if (newSession) totals = Totals()
  }

  @Synchronized internal fun accept(source: Endpoint, raw: Totals) {
    if (source != endpoint || raw.sent < 0 || raw.received < 0) return
    totals = Totals(totals.sent + (raw.sent - previous.sent).coerceAtLeast(0),
      totals.received + (raw.received - previous.received).coerceAtLeast(0))
    previous = raw
  }

  fun poll() {
    val source = synchronized(this) { endpoint } ?: return
    // Loopback only, authenticated per session, without proxies or redirects.
    val connection = URL("http://127.0.0.1:${source.port}/connections").openConnection(Proxy.NO_PROXY) as HttpURLConnection
    connection.connectTimeout = 1500
    connection.readTimeout = 1500
    connection.instanceFollowRedirects = false
    connection.setRequestProperty("Authorization", "Bearer ${source.secret}")
    try {
      check(connection.responseCode == 200)
      val bytes = connection.inputStream.use { input ->
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          check(output.size() + count <= 1024 * 1024)
          output.write(buffer, 0, count)
        }
        output.toByteArray()
      }
      val data = JSONObject(String(bytes, Charsets.UTF_8))
      accept(source, Totals(data.getLong("uploadTotal"), data.getLong("downloadTotal")))
    } finally { connection.disconnect() }
  }
}
