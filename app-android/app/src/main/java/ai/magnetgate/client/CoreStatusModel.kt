package ai.magnetgate.client

import org.json.JSONArray
import org.json.JSONObject

/** One transport a node advertises, as the offer carries it. */
data class Plane(val type: String, val endpoint: String)

/** One plane this client is sitting out, with the reason the user needs to see: how long, and how often. */
data class Pause(val type: String, val untilMs: Long, val fails: Int) {
  fun remainingMs(now: Long): Long = (untilMs - now).coerceAtLeast(0)
}

/** One discovered node, flattened for the screens. */
data class NodeRow(
  val slot: Int,
  val name: String,
  val node: String,
  val country: String,
  val planes: List<Plane>,
  val paused: List<Pause>,
) {
  /** What to call this node on screen: the exit's own name when it has one. */
  val title: String get() = node.ifBlank { name.ifBlank { "slot $slot" } }

  val flag: String get() = flagOf(country)
}

/**
 * What `Mgbox.coreStatus()` returns, parsed once so the screens never touch raw JSON.
 *
 * The document (see `core/mobile`) is the core's whole outward state: whether it runs, where its SOCKS
 * listener is, which nodes it found, and the tail of its log.
 */
data class CoreStatus(
  val running: Boolean = false,
  val socksPort: Int = 0,
  val version: String = "",
  val error: String = "",
  val slots: List<Int> = emptyList(),
  val nodes: List<NodeRow> = emptyList(),
  val logs: List<String> = emptyList(),
) {
  /** A tunnel needs both: the core up and somewhere to send traffic. */
  val ready: Boolean get() = running && nodes.isNotEmpty()

  /** The state the connect screen shows in one line. */
  fun headline(vpnUp: Boolean): String = when {
    !vpnUp -> "Not connected"
    error.isNotEmpty() -> "Error: $error"
    !running -> "Tunnel requested, core is down"
    nodes.isEmpty() -> "Looking for a node…"
    else -> "Connected"
  }

  companion object {
    fun parse(json: String): CoreStatus {
      val root = JSONObject(json)
      val exits = root.optJSONObject("snapshot")?.optJSONArray("exits") ?: JSONArray()
      val nodes = mutableListOf<NodeRow>()
      for (index in 0 until exits.length()) {
        val exit = exits.optJSONObject(index) ?: continue
        val planes = mutableListOf<Plane>()
        val dp = exit.optJSONArray("dp") ?: JSONArray()
        for (plane in 0 until dp.length()) {
          val entry = dp.optJSONObject(plane) ?: continue
          planes += Plane(entry.optString("t"), endpointOf(entry))
        }
        val paused = mutableListOf<Pause>()
        val cooling = exit.optJSONArray("cooling") ?: JSONArray()
        for (pause in 0 until cooling.length()) {
          val entry = cooling.optJSONObject(pause) ?: continue
          paused += Pause(entry.optString("t"), entry.optLong("until"), entry.optInt("fails"))
        }
        nodes += NodeRow(
          slot = exit.optInt("slot"),
          name = exit.optString("name"),
          node = exit.optString("node"),
          country = exit.optString("country"),
          planes = planes,
          paused = paused,
        )
      }
      val logs = mutableListOf<String>()
      val log = root.optJSONArray("logs") ?: JSONArray()
      for (index in 0 until log.length()) logs += log.optString(index)
      return CoreStatus(
        running = root.optBoolean("running"),
        socksPort = root.optInt("socksPort"),
        version = root.optString("version"),
        error = root.optString("error"),
        slots = ints(root.optJSONArray("slots")),
        nodes = nodes,
        logs = logs,
      )
    }

    private fun endpointOf(plane: JSONObject): String {
      val host = plane.optString("host")
      val port = plane.optInt("port")
      return if (host.isEmpty()) "" else "$host:$port"
    }

    private fun ints(values: JSONArray?): List<Int> {
      if (values == null) return emptyList()
      val out = mutableListOf<Int>()
      for (index in 0 until values.length()) out += values.optInt(index)
      return out
    }
  }
}

/** The flag of an ISO 3166-1 alpha-2 country as two regional indicators, or nothing when it is not one. */
fun flagOf(country: String): String {
  val code = country.trim().uppercase()
  if (code.length != 2 || code.any { it !in 'A'..'Z' }) return ""
  val base = 0x1F1E6
  return buildString { for (letter in code) appendCodePoint(base + (letter - 'A')) }
}
