package ai.magnetgate.client

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File

/**
 * Everything the user configures, and the only place the PSK is stored.
 *
 * The store is an `EncryptedSharedPreferences` whose master key lives in the Android Keystore, so the
 * secret is not readable by anything that merely copies the app's data directory. The PSK stays out of
 * every log and out of every intent: the settings screen writes it here, the core reads it here.
 *
 * The acceptance scripts cannot open a Keystore-backed store - they hand the app a plain `files/psk.txt`
 * in its private directory - so that file is still honoured as a fallback, and it is migrated into the
 * encrypted store the first time it is seen.
 *
 * If the platform refuses to create the store (a broken Keystore is rare, not impossible), the failure is
 * reported to the diagnostics screen instead of being hidden; the app keeps working with [legacyPsk].
 */
object Settings {
  private const val TAG = "magnetgate"
  private const val FILE = "magnetgate-settings"
  private const val KEY_PSK = "psk"
  private const val KEY_BOOTSTRAP = "bootstrap"
  private const val KEY_RELAYS = "relays"
  private const val KEY_SLOTS = "slots"
  private const val KEY_EXCLUDED = "excluded"

  @Volatile
  private var cached: SharedPreferences? = null

  @Volatile
  private var failure: String? = null

  private fun open(context: Context): SharedPreferences? {
    cached?.let { return it }
    synchronized(this) {
      cached?.let { return it }
      if (failure != null) return null
      return runCatching {
        val masterKey = MasterKey.Builder(context)
          .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
          .build()
        EncryptedSharedPreferences.create(
          context,
          FILE,
          masterKey,
          EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
          EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
      }.onFailure {
        failure = it.message ?: it.toString()
        Log.e(TAG, "the encrypted settings store is unavailable: $failure")
      }.getOrNull()?.also { cached = it }
    }
  }

  /** Null while the encrypted store works; otherwise why it does not, for the diagnostics screen. */
  fun failureText(context: Context): String? {
    open(context)
    return failure
  }

  private fun get(context: Context, key: String, fallback: String = ""): String =
    open(context)?.getString(key, fallback).orEmpty()

  private fun put(context: Context, key: String, value: String) {
    open(context)?.edit()?.putString(key, value)?.apply()
  }

  /**
   * The PSK: the encrypted store first, the script-written file second, and whatever was found in the
   * file is moved into the store on the way out.
   */
  fun psk(context: Context): String {
    val stored = get(context, KEY_PSK)
    if (stored.isNotBlank()) return stored
    val legacy = legacyPsk(context)
    if (legacy.isNotBlank()) put(context, KEY_PSK, legacy)
    return legacy
  }

  fun setPsk(context: Context, value: String) = put(context, KEY_PSK, value.trim())

  /** True when the PSK only exists as the plain file the acceptance scripts push. */
  fun pskFromFile(context: Context): Boolean = get(context, KEY_PSK).isBlank() && legacyPsk(context).isNotBlank()

  private fun legacyPsk(context: Context): String {
    val file = File(context.filesDir, PSK_FILE)
    return runCatching { if (file.exists()) file.readText().trim() else "" }.getOrDefault("")
  }

  fun bootstrap(context: Context): String = get(context, KEY_BOOTSTRAP)
  fun setBootstrap(context: Context, value: String) = put(context, KEY_BOOTSTRAP, value.trim())

  fun relays(context: Context): String = get(context, KEY_RELAYS)
  fun setRelays(context: Context, value: String) = put(context, KEY_RELAYS, value.trim())

  /** The slots to look for, as stored; one slot 0 by default, the only one a single-exit setup has. */
  fun slots(context: Context): List<Int> = parseSlots(get(context, KEY_SLOTS, "0"))

  fun setSlots(context: Context, slots: List<Int>) = put(context, KEY_SLOTS, slots.joinToString(","))

  /** Packages the tunnel must leave alone, as stored. */
  fun excluded(context: Context): List<String> =
    open(context)?.getStringSet(KEY_EXCLUDED, emptySet())?.sorted().orEmpty()

  fun setExcluded(context: Context, packages: Collection<String>) {
    open(context)?.edit()?.putStringSet(KEY_EXCLUDED, packages.toSet())?.apply()
  }

  /**
   * The rendezvous slot range: the same bound as MAX_SLOTS in src/common.mjs and MaxSlots in
   * core/proto/keys.go, kept equal by a drift test. The field used to accept 0..255, which let a
   * user enter a slot the core would then refuse outright.
   */
  const val MAX_SLOTS = 16

  fun parseSlots(value: String): List<Int> =
    value.split(',', ' ', '\n').mapNotNull { it.trim().toIntOrNull() }.filter { it in 0 until MAX_SLOTS }.distinct()

  /** The file the scripts use; named here so nothing has to repeat the literal. */
  const val PSK_FILE = "psk.txt"
}
