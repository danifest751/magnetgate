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
    // is the fallback - the same order the desktop client uses.
    config.put("preference", array(PREFERENCE))
    return config.toString()
  }

  /** The order the core tries a node's planes in, as src/transport-config.cjs orders them. */
  val PREFERENCE = listOf("reality", "hy2", "mgt")

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
