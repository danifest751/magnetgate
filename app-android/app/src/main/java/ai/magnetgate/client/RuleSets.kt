package ai.magnetgate.client

import android.content.Context
import android.util.Log
import java.io.File
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

/**
 * The routing rule-sets the engine reads: unpacked from the package, then kept current from what an
 * exit advertises.
 *
 * These are the same binary `.srs` files the desktop routes by, pinned by SHA-256 in
 * `scripts/pins.json`. The package carries a copy so a fresh install has lists at once, and after that
 * they are replaced by whatever the node's manifest names - otherwise the lists that decide what
 * bypasses the tunnel would be frozen at the moment the app was built.
 *
 * Trust rests entirely on the digest. The manifest is sealed with the key derived from the PSK, so only
 * the operator can say which lists are current; the files themselves are fetched from wherever it
 * points, through the tunnel, and a download whose digest does not match is discarded. A mirror serving
 * something else therefore fails verification instead of quietly retuning anyone's routing.
 *
 * Nothing here can leave the device without lists. Every failure keeps what is already on disk, and a
 * missing set is not an error at all: the desktop builder skips one whose file is absent, and a build
 * made without running `get-singbox.ps1` still produces an app that tunnels, it just cannot split.
 */
object RuleSets {
  private const val TAG = "magnetgate"
  private const val DIR = "rule-sets"
  private const val STATE = "state.json"

  /** Tag the engine configuration and the manifest both use, and the asset it is packaged as. */
  private val PACKAGED = listOf(
    "blocked-domains" to "refilter-domains.srs",
    "blocked-ip" to "refilter-ip.srs",
    "user" to "tunnel-userlist.srs",
  )

  /** A rule-set the engine can be pointed at: its tag and the file it lives in. */
  data class Available(val tag: String, val path: String)

  /** What is on disk for one set, and where it came from. */
  private data class Entry(val sha256: String, val fromManifest: Boolean, val generation: Int)

  /**
   * How one pass over a manifest ended.
   *
   * [changed] is the caller's signal to reload the engine. [settled] says whether there is any point in
   * repeating the pass: a source that could not be reached may work in a minute, while a source serving
   * something other than what the operator published will keep serving it, and re-downloading megabytes
   * every few seconds to reach the same verdict would cost the user traffic and bury the log.
   */
  data class Result(val changed: Boolean, val settled: Boolean)

  /**
   * Unpacks what the package carries, without disturbing anything already replaced from a manifest, and
   * returns what is on disk afterwards. An empty list means "nothing to split on", never a failure.
   */
  fun ensure(context: Context): List<Available> {
    val dir = File(context.filesDir, DIR)
    if (!dir.exists() && !dir.mkdirs()) {
      Log.w(TAG, "rule-sets: cannot create $dir")
      return emptyList()
    }
    val state = readState(dir).toMutableMap()
    val out = mutableListOf<Available>()
    for ((tag, asset) in PACKAGED) {
      val target = File(dir, asset)
      val known = state[asset]
      val packagedSha = runCatching { sha256(context.assets.open("$DIR/$asset").use { it.readBytes() }) }
        .getOrNull()
      try {
        val unpack = when {
          !target.exists() -> true
          known == null -> true // a file of unknown origin is not one we can reason about
          // A newer package carries newer lists, but only replace what came from the package: a set
          // already replaced from a manifest is more current than anything built into the app.
          !known.fromManifest && packagedSha != null && known.sha256 != packagedSha -> true
          else -> false
        }
        if (unpack) {
          if (packagedSha == null) throw IllegalStateException("not packaged")
          context.assets.open("$DIR/$asset").use { input ->
            val tmp = File(dir, "$asset.tmp")
            tmp.outputStream().use { output -> input.copyTo(output) }
            if (!tmp.renameTo(target)) throw IllegalStateException("cannot replace $target")
          }
          state[asset] = Entry(packagedSha, fromManifest = false, generation = 0)
        }
      } catch (error: Throwable) {
        Log.w(TAG, "rule-sets: $asset unavailable: ${error.message}")
      }
      if (target.exists()) out.add(Available(tag, target.absolutePath))
    }
    writeState(dir, state)
    Log.i(TAG, "rule-sets: ${out.size} of ${PACKAGED.size} available")
    return out
  }

  /**
   * Brings the sets named by [manifest] up to date, downloading through the core's own SOCKS listener so
   * the fetch goes the same way the traffic does.
   *
   * Returns true when something on disk changed, which is the caller's signal that the engine has to be
   * reloaded. A set whose digest already matches is not downloaded. Any failure - unreachable source,
   * wrong size, wrong digest - leaves the previous file untouched and is reported, never thrown: an
   * update that cannot be verified must not cost the user the lists they already had.
   */
  fun update(context: Context, manifest: JSONObject, socksPort: Int): Result {
    val sets = manifest.optJSONArray("sets") ?: return Result(changed = false, settled = true)
    val generation = manifest.optInt("v", 0)
    // no usable port yet is worth retrying; a manifest without a generation is not
    if (socksPort == 0) return Result(changed = false, settled = false)
    if (generation < 1) return Result(changed = false, settled = true)
    val dir = File(context.filesDir, DIR)
    val state = readState(dir).toMutableMap()
    var changed = false
    var settled = true

    for (index in 0 until sets.length()) {
      val set = sets.optJSONObject(index) ?: continue
      val tag = set.optString("tag")
      val asset = PACKAGED.firstOrNull { it.first == tag }?.second ?: continue // a tag we do not carry
      val want = set.optString("sha256").lowercase()
      val url = set.optString("url")
      val bytes = set.optInt("bytes")
      if (want.length != 64 || !url.startsWith("https://") || bytes !in 1..MAX_BYTES) {
        Log.w(TAG, "rule-sets: $tag: the manifest entry is not usable")
        continue
      }
      if (state[asset]?.sha256 == want) continue // already current

      val body = runCatching { download(url, bytes, socksPort) }
        .onFailure {
          Log.w(TAG, "rule-sets: $tag: not fetched: ${it.message}")
          settled = false // the source may be reachable again shortly
        }
        .getOrNull() ?: continue
      val got = sha256(body)
      if (got != want) {
        // The one case worth saying loudly: the source served something other than what the operator
        // published. Keeping the old file is the whole point of checking.
        Log.w(TAG, "rule-sets: $tag: digest mismatch, keeping the previous list (want $want, got $got)")
        continue
      }
      try {
        val tmp = File(dir, "$asset.tmp")
        tmp.writeBytes(body)
        val target = File(dir, asset)
        if (!tmp.renameTo(target)) throw IllegalStateException("cannot replace $target")
        state[asset] = Entry(got, fromManifest = true, generation = generation)
        changed = true
        Log.i(TAG, "rule-sets: $tag updated to generation $generation (${body.size} bytes)")
      } catch (error: Throwable) {
        Log.w(TAG, "rule-sets: $tag: not written: ${error.message}")
        settled = false
      }
    }
    if (changed) writeState(dir, state)
    return Result(changed, settled)
  }

  /** The generation currently on disk, for the diagnostics screen; 0 when nothing came from a manifest. */
  fun generation(context: Context): Int =
    readState(File(context.filesDir, DIR)).values.filter { it.fromManifest }.minOfOrNull { it.generation } ?: 0

  private const val MAX_BYTES = 8 shl 20

  private fun download(url: String, expectedBytes: Int, socksPort: Int): ByteArray {
    val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort))
    val connection = URL(url).openConnection(proxy) as HttpsURLConnection
    connection.connectTimeout = 30_000
    connection.readTimeout = 60_000
    connection.instanceFollowRedirects = true
    try {
      if (connection.responseCode != 200) throw IllegalStateException("HTTP ${connection.responseCode}")
      // Read at most one byte more than promised: a source that sends more is not serving the file the
      // manifest describes, and there is no reason to spend a phone's data finding out how much more.
      val cap = minOf(expectedBytes, MAX_BYTES)
      // readNBytes недоступен до Android 13; сохраняем ограничение размера на minSdk 26.
      val body = connection.inputStream.use { input ->
        val buffer = ByteArray(cap + 1)
        var size = 0
        while (size < buffer.size) {
          val read = input.read(buffer, size, buffer.size - size)
          if (read < 0) break
          size += read
        }
        buffer.copyOf(size)
      }
      if (body.size != expectedBytes) throw IllegalStateException("got ${body.size}B, manifest says ${expectedBytes}B")
      return body
    } finally {
      connection.disconnect()
    }
  }

  private fun sha256(body: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }

  private fun readState(dir: File): Map<String, Entry> {
    val file = File(dir, STATE)
    return runCatching {
      val doc = JSONObject(file.readText())
      buildMap {
        for (key in doc.keys()) {
          val entry = doc.getJSONObject(key)
          put(
            key,
            Entry(
              entry.optString("sha256"),
              entry.optBoolean("fromManifest"),
              entry.optInt("generation"),
            ),
          )
        }
      }
    }.getOrDefault(emptyMap())
  }

  private fun writeState(dir: File, state: Map<String, Entry>) {
    runCatching {
      val doc = JSONObject()
      for ((key, entry) in state) {
        doc.put(
          key,
          JSONObject()
            .put("sha256", entry.sha256)
            .put("fromManifest", entry.fromManifest)
            .put("generation", entry.generation),
        )
      }
      val tmp = File(dir, "$STATE.tmp")
      tmp.writeText(doc.toString())
      tmp.renameTo(File(dir, STATE))
    }.onFailure { Log.w(TAG, "rule-sets: state not written: ${it.message}") }
  }
}
