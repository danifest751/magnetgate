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

  /**
   * Where the time went, for a measurement that finished.
   *
   * The total on its own reads like a ping and frightens people who compare it with one: it is nothing
   * of the sort. Every check opens a **new** connection and carries a whole HTTPS request through the
   * entire chain - SOCKS, the engine's own resolver, reality to an exit in another country, then that
   * exit's own TCP and TLS to the destination - so half a second is what a healthy phone looks like,
   * and what matters is which leg grew, not the sum.
   */
  data class Legs(
    val connectMs: Long,
    val tlsMs: Long,
    val answerMs: Long,
    /**
     * One round trip over the connection the legs above paid for, which is the only number here that
     * means what a person expects a number under "Connected" to mean. Null when the destination hung up
     * after its first answer, which it is entitled to do.
     */
    val pingMs: Long? = null,
  ) {
    /** Compact and in a fixed order, so two readings can be compared by eye or by grep. */
    override fun toString(): String = "$connectMs/$tlsMs/$answerMs" + (pingMs?.let { "/$it" } ?: "")

    fun summary(): String = "connect ${connectMs}ms · TLS ${tlsMs}ms · answer ${answerMs}ms"
  }

  /** One measurement of the path traffic actually takes. */
  data class Check(
    val atMs: Long,
    val ok: Boolean,
    val tookMs: Long,
    val detail: String,
    val legs: Legs? = null,
  ) {
    val slow: Boolean get() = ok && tookMs >= SLOW_MS

    /** What the connect screen says in one line, without the timestamp. */
    fun summary(): String = when {
      !ok -> "failed: $detail"
      slow -> "slow: $detail in ${seconds(tookMs)}"
      else -> "$detail in ${seconds(tookMs)}"
    }

    // Locale.US on purpose: this is a measurement, and a reading that comes out as "1,4s" on one phone
    // and "1.4s" on another is a reading nobody can paste into a report or compare with a log line.
    private fun seconds(ms: Long): String =
      if (ms < 1000) "${ms}ms" else String.format(java.util.Locale.US, "%.1fs", ms / 1000.0)
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
      onSuccess = { Check(System.currentTimeMillis(), ok = true, tookMs = took, detail = it.first, legs = it.second) },
      onFailure = {
        Check(System.currentTimeMillis(), ok = false, tookMs = took, detail = it.message ?: it.javaClass.simpleName)
      },
    )
    lastCheck = check
    // The legs go to the log and not into summary(): the screen takes the last word of that line as the
    // measurement, and a reading with three more numbers after it would quietly become "278ms".
    if (!check.ok || check.slow) {
      Log.w(TAG, "exit check: ${check.summary()}" + (check.legs?.let { " ($it)" } ?: ""))
    }
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
  private fun fetch(socksPort: Int, url: String): Pair<String, Legs> {
    val parsed = URL(url)
    val host = parsed.host
    val port = if (parsed.port != -1) parsed.port else if (parsed.protocol == "https") 443 else 80
    val path = parsed.path.ifEmpty { "/" }

    val socket = Socket(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort)))
    socket.use {
      it.soTimeout = 15_000
      // Three legs, timed apart, because the sum says nothing about where a slow phone is slow: this
      // one covers the SOCKS handshake, the engine resolving the name and everything up to the exit
      // having a stream to the destination.
      val before = System.currentTimeMillis()
      it.connect(InetSocketAddress.createUnresolved(host, port), 15_000)
      val connected = System.currentTimeMillis()
      val stream: Socket = if (parsed.protocol == "https") {
        (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(it, host, port, false).also { tls ->
          (tls as SSLSocket).startHandshake()
        }
      } else {
        it
      }
      // TLS is end to end with the destination, so this leg is round trips over the whole chain and
      // never anything our own machinery can shorten.
      val handshaken = System.currentTimeMillis()
      val writer = stream.getOutputStream().bufferedWriter()
      val reader = stream.getInputStream().bufferedReader()
      // The connection is kept open on purpose: the second request over it is the measurement a person
      // actually recognises (see [Legs.pingMs]), and it only exists if nobody hung up first.
      val body = request(writer, reader, host, path, close = false)
      if (body.isEmpty()) throw IllegalStateException("the exit answered with no body")
      val done = System.currentTimeMillis()

      // One round trip over an open connection: no SOCKS, no resolver, no handshakes - phone to exit to
      // destination and back. Never allowed to fail the check: a server within its rights to close after
      // the first answer would otherwise turn a healthy exit into a red screen.
      val ping = runCatching {
        val asked = System.currentTimeMillis()
        request(writer, reader, host, path, close = true)
        System.currentTimeMillis() - asked
      }.getOrNull()

      return body.take(64) to Legs(
        connectMs = connected - before,
        tlsMs = handshaken - connected,
        answerMs = done - handshaken,
        pingMs = ping,
      )
    }
  }

  /**
   * One HTTP request and its answer, read by `Content-Length` rather than by the connection closing.
   *
   * Reading to end-of-stream is simpler and is what this did before, but it can only ever be done once:
   * it needs the other side to hang up. Framing the answer properly is what leaves the connection usable
   * for the round trip that follows.
   */
  private fun request(
    writer: java.io.Writer,
    reader: java.io.BufferedReader,
    host: String,
    path: String,
    close: Boolean,
  ): String {
    writer.write(
      "GET $path HTTP/1.1\r\nHost: $host\r\n" +
        "Connection: ${if (close) "close" else "keep-alive"}\r\nUser-Agent: magnetgate/1.0\r\n\r\n",
    )
    writer.flush()
    val status = reader.readLine() ?: throw IllegalStateException("the exit answered with nothing")
    if (!status.contains(" 200")) throw IllegalStateException(status.ifEmpty { "no status line" })
    var length = -1
    while (true) {
      val line = reader.readLine() ?: throw IllegalStateException("the answer ended inside its headers")
      if (line.isEmpty()) break
      val name = line.substringBefore(':').trim().lowercase()
      if (name == "content-length") length = line.substringAfter(':').trim().toIntOrNull() ?: -1
    }
    // No length means the answer is framed by the connection closing (or chunked), and then this is the
    // last request this connection can carry - read it to the end and let the caller find out.
    if (length < 0) return reader.readText().trim()
    val body = CharArray(length)
    var read = 0
    while (read < length) {
      val got = reader.read(body, read, length - read)
      if (got < 0) break
      read += got
    }
    return String(body, 0, read).trim()
  }

  private const val TAG = "magnetgate"
}
