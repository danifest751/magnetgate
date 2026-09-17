package ai.magnetgate.client

import android.util.Log
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL

/**
 * What the app knows about its own health, written by the service and read by the screens.
 *
 * This exists because of the DNS regress of 2026-09-17. The tunnel was up, the screen was green, the
 * node list looked healthy, and the only thing wrong was that traffic had become slow - which the owner
 * noticed by hand, half an hour before the cause was found. Nothing on the phone said anything, because
 * nothing was measured after the tunnel came up: the egress check ran once, at connect, and its result
 * was a string on the screen with no time attached to it.
 *
 * So the check repeats, and it records how long it took as well as whether it worked. "ok in 9s" is the
 * shape that failure actually had, and a check that only reported ok/failed would have stayed green
 * through it.
 */
object Health {

  /** Longer than this and the exit is reachable but not usable; the DNS regress looked exactly so. */
  const val SLOW_MS = 4_000L

  /** One measurement of the path traffic actually takes. */
  data class Check(val atMs: Long, val ok: Boolean, val tookMs: Long, val detail: String) {
    val slow: Boolean get() = ok && tookMs >= SLOW_MS

    /** What the connect screen says in one line, without the timestamp. */
    fun summary(): String = when {
      !ok -> "failed: $detail"
      slow -> "slow: $detail in ${seconds(tookMs)}"
      else -> "$detail in ${seconds(tookMs)}"
    }

    private fun seconds(ms: Long): String = if (ms < 1000) "${ms}ms" else "%.1fs".format(ms / 1000.0)
  }

  @Volatile
  var lastCheck: Check? = null
    private set

  /**
   * The last thing the engine refused to do. Engine failures used to go to logcat and nowhere else, so
   * a phone that could not build or reload its tunnel said nothing at all to the person holding it.
   */
  @Volatile
  var engineError: String = ""
    private set

  fun recordEngineError(message: String) {
    engineError = message
  }

  fun clearEngineError() {
    engineError = ""
  }

  /** Forgets everything: a new tunnel must not be judged by the previous one's measurements. */
  fun reset() {
    lastCheck = null
    engineError = ""
  }

  /**
   * Runs one check through the core's SOCKS listener and records it.
   *
   * It is deliberately the whole round trip rather than a connect: an exit that accepts a stream and
   * then carries nothing is the failure this project keeps meeting, and a check that stops at "the
   * socket opened" would call it healthy (see the relay channel in core/nostr).
   */
  fun check(socksPort: Int, url: String): Check {
    val started = System.currentTimeMillis()
    val result = runCatching { fetch(socksPort, url) }
    val took = System.currentTimeMillis() - started
    val check = result.fold(
      onSuccess = { Check(System.currentTimeMillis(), ok = true, tookMs = took, detail = it) },
      onFailure = {
        Check(System.currentTimeMillis(), ok = false, tookMs = took, detail = it.message ?: it.javaClass.simpleName)
      },
    )
    lastCheck = check
    if (!check.ok || check.slow) Log.w(TAG, "exit check: ${check.summary()}")
    return check
  }

  private fun fetch(socksPort: Int, url: String): String {
    val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort))
    val connection = URL(url).openConnection(proxy) as HttpURLConnection
    connection.connectTimeout = 15_000
    connection.readTimeout = 15_000
    try {
      val body = connection.inputStream.bufferedReader().use { it.readText().trim() }
      if (body.isEmpty()) throw IllegalStateException("the exit answered with nothing")
      return body.take(64)
    } finally {
      connection.disconnect()
    }
  }

  private const val TAG = "magnetgate"
}
