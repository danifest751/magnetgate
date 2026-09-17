package ai.magnetgate.client

import android.util.Log
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.URL
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

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

  /**
   * One HTTPS GET through a SOCKS listener, with the destination left as a **name**.
   *
   * The name is the whole point. `InetSocketAddress.createUnresolved` is what makes Java's SOCKS client
   * send the domain instead of resolving it here first, and only then does whatever is behind the
   * listener have to resolve it. Through the engine's listener that is the engine's own resolver - the
   * part that broke on 17.09 - and a check that let Java resolve locally would test nothing of it.
   */
  private fun fetch(socksPort: Int, url: String): String {
    val parsed = URL(url)
    val host = parsed.host
    val port = if (parsed.port != -1) parsed.port else if (parsed.protocol == "https") 443 else 80
    val path = parsed.path.ifEmpty { "/" }

    val socket = Socket(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort)))
    socket.use {
      it.soTimeout = 15_000
      it.connect(InetSocketAddress.createUnresolved(host, port), 15_000)
      val stream: Socket = if (parsed.protocol == "https") {
        (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(it, host, port, false).also { tls ->
          (tls as SSLSocket).startHandshake()
        }
      } else {
        it
      }
      val writer = stream.getOutputStream().bufferedWriter()
      writer.write("GET $path HTTP/1.1\r\nHost: $host\r\nConnection: close\r\nUser-Agent: magnetgate/1.0\r\n\r\n")
      writer.flush()
      val text = stream.getInputStream().bufferedReader().readText()
      val separator = text.indexOf("\r\n\r\n")
      if (separator < 0) throw IllegalStateException("the exit answered with nothing")
      val status = text.lineSequence().firstOrNull().orEmpty()
      if (!status.contains(" 200")) throw IllegalStateException(status.ifEmpty { "no status line" })
      val body = text.substring(separator + 4).trim()
      if (body.isEmpty()) throw IllegalStateException("the exit answered with no body")
      return body.take(64)
    }
  }

  private const val TAG = "magnetgate"
}
