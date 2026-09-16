package ai.magnetgate.client

import android.content.Context
import android.util.Log
import java.io.File

/**
 * The routing rule-sets the engine reads, unpacked from the APK.
 *
 * These are the same binary `.srs` files the desktop uses (`tools/sing-box/`, pinned by SHA-256 in
 * `scripts/pins.json` and fetched by `scripts/get-singbox.ps1`); the Gradle build copies them into the
 * package, so what a phone routes by is the same list a desktop routes by, from the same pin.
 *
 * libbox reads a rule-set from a path, not from a stream, so each one is written into the app's private
 * directory once and re-written whenever the packaged copy differs in size - which is what happens after
 * an update that carries a newer list.
 *
 * A missing set is not an error. The desktop builder skips a set whose file is absent rather than
 * refusing to start, and the same has to hold here: a build made without running `get-singbox.ps1` still
 * produces an app that tunnels, it just has nothing to split on.
 */
object RuleSets {
  private const val TAG = "magnetgate"
  private const val DIR = "rule-sets"

  /** Tag the engine configuration refers to, and the asset it comes from. */
  private val PACKAGED = listOf(
    "blocked-domains" to "refilter-domains.srs",
    "blocked-ip" to "refilter-ip.srs",
    "user" to "tunnel-userlist.srs",
  )

  /** A rule-set the engine can be pointed at: its tag and the file it was unpacked to. */
  data class Available(val tag: String, val path: String)

  /**
   * Unpacks whatever is packaged and returns what is actually on disk afterwards. Callers treat an empty
   * list as "no lists to split on", never as a failure.
   */
  fun ensure(context: Context): List<Available> {
    val dir = File(context.filesDir, DIR)
    if (!dir.exists() && !dir.mkdirs()) {
      Log.w(TAG, "rule-sets: cannot create $dir")
      return emptyList()
    }
    val out = mutableListOf<Available>()
    for ((tag, asset) in PACKAGED) {
      val target = File(dir, asset)
      val copied = runCatching { copyIfNeeded(context, asset, target) }.getOrElse {
        Log.w(TAG, "rule-sets: $asset unavailable: ${it.message}")
        false
      }
      if (copied || target.exists()) out.add(Available(tag, target.absolutePath))
    }
    Log.i(TAG, "rule-sets: ${out.size} of ${PACKAGED.size} available")
    return out
  }

  private fun copyIfNeeded(context: Context, asset: String, target: File): Boolean {
    // openFd only works on an uncompressed asset, which is why the build declares `noCompress` for
    // .srs; the files are already compact binaries, so nothing is lost by not deflating them.
    val packagedSize = context.assets.openFd("$DIR/$asset").use { it.length }
    if (target.exists() && target.length() == packagedSize) return true
    context.assets.open("$DIR/$asset").use { input ->
      target.outputStream().use { output -> input.copyTo(output) }
    }
    return true
  }
}
