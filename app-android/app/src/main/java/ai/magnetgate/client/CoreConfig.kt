package ai.magnetgate.client

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * The JSON the core is started with, in one place: the screen and the service must not disagree about
 * it, and the contract is checked by the core (it refuses a document it cannot read).
 */
object CoreConfig {
  fun json(psk: String, bootstrap: List<String>, relays: List<String>): String {
    val config = JSONObject()
    config.put("psk", psk)
    // slots are numbers: the core decodes them as []int
    config.put("slots", JSONArray().put(0))
    config.put("bootstrap", array(bootstrap))
    config.put("relays", array(relays))
    return config.toString()
  }

  fun array(values: List<String>): JSONArray {
    val array = JSONArray()
    for (value in values) array.put(value)
    return array
  }

  fun splitList(value: String): List<String> =
    value.split(',', ' ', '\n').map { it.trim() }.filter { it.isNotEmpty() }

  /**
   * The PSK is read from the app's private files directory for now; the settings screen will own it
   * behind EncryptedSharedPreferences. It never travels on a command line or through an intent.
   */
  fun readPsk(context: Context): String {
    val file = File(context.filesDir, "psk.txt")
    return if (file.exists()) file.readText().trim() else ""
  }
}
