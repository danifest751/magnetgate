package ai.magnetgate.client

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The JSON the core is started with, in one place: the screen and the service must not disagree about
 * it, and the contract is checked by the core (it refuses a document it cannot read).
 */
object CoreConfig {
  fun json(psk: String, slots: List<Int>, bootstrap: List<String>, relays: List<String>): String {
    val config = JSONObject()
    config.put("psk", psk)
    // slots are numbers: the core decodes them as []int
    config.put("slots", numbers(slots.ifEmpty { listOf(0) }))
    config.put("bootstrap", array(bootstrap))
    config.put("relays", array(relays))
    // Transports in order of preference: the two the engine speaks for us come first, and the native mux
    // is the fallback - the same order the desktop client uses, and the same measurement behind it.
    config.put("preference", array(PREFERENCE))
    return config.toString()
  }

  /**
   * The order the core tries a node's planes in.
   *
   * Copied from `PLANE_ORDER` in `src/health.mjs`, which is where this is decided and where the
   * measurement behind it is written down. It cannot be imported across languages, so a drift gate
   * holds the two together (`drift: every client tries a node's planes in the same order`). The comment
   * this replaced pointed at `src/transport-config.cjs`, which orders nothing and never did - the shape
   * of rot a gate exists to stop.
   */
  val PREFERENCE = listOf("hy2", "reality", "mgt")

  fun array(values: List<String>): JSONArray {
    val array = JSONArray()
    for (value in values) array.put(value)
    return array
  }

  private fun numbers(values: List<Int>): JSONArray {
    val array = JSONArray()
    for (value in values) array.put(value)
    return array
  }

  fun splitList(value: String): List<String> =
    value.split(',', ' ', '\n').map { it.trim() }.filter { it.isNotEmpty() }

  /**
   * The PSK, from the place that owns it. It never travels on a command line or through an intent, and
   * the plain file the acceptance scripts use is still honoured (see [Settings]).
   */
  fun readPsk(context: Context): String = Settings.psk(context)
}
