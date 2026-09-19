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
  private const val KEY_MODE = "mode"
  private const val KEY_DIRECT_DOMAINS = "directDomains"
  private const val KEY_TUNNEL_DOMAINS = "tunnelDomains"
  private const val KEY_COUNTRY = "country"
  private const val KEY_APPS = "apps"
  private const val KEY_REVISION = "settingsRevision"

  fun revision(context: Context): Long = get(context, KEY_REVISION).toLongOrNull() ?: 0L

  /** Настройки и их версия записываются вместе; ошибка записи не считается сохранением. */
  fun saveRouting(context: Context, draft: RoutingDraft): Boolean {
    val store = open(context) ?: return false
    return store.edit()
      .putString(KEY_MODE, draft.mode.stored)
      .putString(KEY_APPS, draft.apps.stored)
      .putStringSet(KEY_EXCLUDED, draft.packages.toSet())
      .putString(KEY_DIRECT_DOMAINS, draft.direct.joinToString(SEPARATOR))
      .putString(KEY_TUNNEL_DOMAINS, draft.tunnel.joinToString(SEPARATOR))
      .putString(KEY_REVISION, (revision(context) + 1).toString())
      .commit()
  }

  fun saveAccess(context: Context, psk: String, bootstrap: String, relays: String, slots: String): Boolean {
    val store = open(context) ?: return false
    return store.edit()
      .putString(KEY_PSK, psk.trim())
      .putString(KEY_BOOTSTRAP, bootstrap.trim())
      .putString(KEY_RELAYS, relays.trim())
      .putString(KEY_SLOTS, parseSlots(slots).joinToString(","))
      .putString(KEY_REVISION, (revision(context) + 1).toString())
      .commit()
  }

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

  /**
   * The relays a phone falls back on when nothing has been typed in.
   *
   * There was no default at all: a device provisioned without relays had no Nostr channel, which means
   * no hy2 and no rule-set manifest, and nothing said so. The list mirrors src/nostr.mjs, where it lives
   * first.
   *
   * Which relays, measured on 2026-09-19 with `cmd/nostr-probe` (four subscriptions each, our own sealed
   * offers, not a ping): nos.lol and nostr.mom served ten, relay.primal.net and relay.snort.social nine,
   * relay.damus.io seven with one handshake refused by its edge (503). Two candidates were dropped for
   * the reason this project keeps meeting: offchain.pub connected four times out of four and served
   * **nothing**, and nostr.wine refused. A relay that connects and stays mute is the failure mode the
   * channel was rewritten to notice, so it must not be in the default list.
   *
   * Five and not one: relay health varies by day and by network - on 18.09 nos.lol answered 502 from
   * this same phone while primal carried everything.
   */
  const val DEFAULT_RELAYS =
    "wss://nos.lol,wss://nostr.mom,wss://relay.primal.net,wss://relay.snort.social,wss://relay.damus.io"

  fun relays(context: Context): String = get(context, KEY_RELAYS).ifBlank { DEFAULT_RELAYS }
  fun setRelays(context: Context, value: String) = put(context, KEY_RELAYS, value.trim())

  /**
   * What a launch extra means for a discovery channel: blank is "use the stored setting", and the literal
   * [CHANNEL_OFF] is "this channel is off for this run".
   *
   * The second exists for the acceptance runs. Leaving an extra out falls back to the store, so a run
   * meant to prove "the phone finds a node over DHT alone" would quietly keep the stored relays and prove
   * nothing - the same shape of mistake as a check that passes because nothing ran.
   */
  const val CHANNEL_OFF = "none"

  fun channel(extra: String, stored: String): String = when {
    extra.isBlank() -> stored
    extra.trim().equals(CHANNEL_OFF, ignoreCase = true) -> ""
    else -> extra.trim()
  }

  /** The slots to look for, as stored; one slot 0 by default, the only one a single-exit setup has. */
  fun slots(context: Context): List<Int> = parseSlots(get(context, KEY_SLOTS, "0"))

  fun setSlots(context: Context, slots: List<Int>) = put(context, KEY_SLOTS, slots.joinToString(","))

  /** Packages the tunnel must leave alone, as stored. */
  /**
   * Which country the user wants their traffic to leave through, or empty for any.
   *
   * A preference and not a restriction, exactly as on the desktop: when the chosen country has no live
   * node, the client uses whatever is there rather than refusing to carry traffic (pool.SelectCountry).
   */
  fun country(context: Context): String = get(context, KEY_COUNTRY).uppercase()

  fun setCountry(context: Context, value: String) =
    put(context, KEY_COUNTRY, value.trim().uppercase().take(2))

  /**
   * What the chosen list of applications means.
   *
   * The same list reads two ways, and the difference is the whole feature: [Apps.EXCEPT] is "everything
   * goes through the tunnel but these", which is what this client has always done, and [Apps.ONLY] is
   * "nothing goes through it except these" - a phone that tunnels one messenger and leaves banking and
   * local services alone.
   */
  enum class Apps(val stored: String) {
    EXCEPT("except"),
    ONLY("only"),
    ;

    companion object {
      fun of(value: String): Apps = entries.firstOrNull { it.stored == value } ?: EXCEPT
    }
  }

  fun apps(context: Context): Apps = Apps.of(get(context, KEY_APPS, Apps.EXCEPT.stored))

  fun setApps(context: Context, value: Apps) = put(context, KEY_APPS, value.stored)

  fun excluded(context: Context): List<String> =
    open(context)?.getStringSet(KEY_EXCLUDED, emptySet())?.sorted().orEmpty()

  fun setExcluded(context: Context, packages: Collection<String>) {
    open(context)?.edit()?.putStringSet(KEY_EXCLUDED, packages.toSet())?.apply()
  }

  /**
   * How much traffic the tunnel takes, mirroring the desktop's two modes (app/vpn-config.cjs):
   *
   *  - [Mode.FULL]  everything goes through the tunnel; only the domains the user lists explicitly go
   *                 direct. A bundled list must never silently bypass the tunnel, whatever it is called.
   *  - [Mode.SPLIT] only what the rule-sets and the user's tunnel list name goes through the tunnel,
   *                 everything else goes direct.
   */
  enum class Mode(val stored: String) {
    FULL("full"),
    SPLIT("split"),
    ;

    companion object {
      fun of(value: String): Mode = entries.firstOrNull { it.stored == value } ?: FULL
    }
  }

  fun mode(context: Context): Mode = Mode.of(get(context, KEY_MODE, Mode.FULL.stored))

  fun setMode(context: Context, mode: Mode) = put(context, KEY_MODE, mode.stored)

  /** Domains the tunnel must leave alone (full mode); the user's explicit exceptions. */
  fun directDomains(context: Context): List<String> = parseDomains(get(context, KEY_DIRECT_DOMAINS))

  fun setDirectDomains(context: Context, value: String) =
    put(context, KEY_DIRECT_DOMAINS, parseDomains(value).joinToString(SEPARATOR))

  /** Domains that must go through the tunnel (split mode), on top of the rule-sets. */
  fun tunnelDomains(context: Context): List<String> = parseDomains(get(context, KEY_TUNNEL_DOMAINS))

  fun setTunnelDomains(context: Context, value: String) =
    put(context, KEY_TUNNEL_DOMAINS, parseDomains(value).joinToString(SEPARATOR))

  /**
   * Mirrors `domains()` in src/config.cjs: lowercase, a leading `*.` and a trailing dot dropped, and
   * anything that is not a plausible host name silently ignored rather than fed to the engine, which
   * would reject the whole configuration over one typo.
   */
  fun parseDomains(value: String): List<String> =
    value
      .split(',', ' ', '\n', '\r', '\t')
      .asSequence()
      .map { it.trim().lowercase().removePrefix("*.").removeSuffix(".") }
      .filter { it.isNotEmpty() && it.length <= 253 && DOMAIN.matches(it) }
      .distinct()
      .take(MAX_DOMAINS)
      .toList()

  // stored one per line; the parser accepts commas and spaces too, so a paste of either works
  private const val SEPARATOR = "\n"
  private val DOMAIN = Regex("^[a-z0-9_.-]+$")
  private const val MAX_DOMAINS = 10000

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
