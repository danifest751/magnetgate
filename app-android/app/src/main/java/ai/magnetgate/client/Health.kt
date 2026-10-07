package ai.magnetgate.client

import android.util.Log
import java.net.InetSocketAddress
import java.net.Socket

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
   * How long the node gets to answer a handshake before the number is simply left out. Short on
   * purpose: this is a decoration on a screen, and it must never hold up the measurement that matters.
   */
  private const val NODE_PING_TIMEOUT_MS = 2_000

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
    /**
     * Round trip to the node that carried this measurement: a TCP handshake for private TCP planes,
     * or an ICMP echo for a confirmed public QUIC exit. This measures our node, not the destination.
     *
     * The two side by side are what a person is actually asking when they ask whether it is slow: a
     * node 40 ms away and a whole path of 800 ms says the far side is slow, while 400 and 800 says the
     * node is simply far. One number could never tell those apart, and this screen was showing one.
     *
     * Measured outside the tunnel on purpose - the app excludes itself from its own VPN - because a
     * handshake that went through the tunnel would be measuring the tunnel, which is the other number.
     * Null when no node measurement is available. Public QUIC measurements are attached by the
     * service after matching the observed exit against the authenticated node list.
     */
    val nodeMs: Long? = null,
  ) {
    /** Compact and in a fixed order, so two readings can be compared by eye or by grep. */
    override fun toString(): String =
      "$connectMs/$tlsMs/$answerMs" + (pingMs?.let { "/$it" } ?: "") + (nodeMs?.let { "/$it" } ?: "")

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
  @Synchronized
  fun reset() {
    lastCheck = null
    engineError = ""
  }

  /**
   * Measures one check through SOCKS. The owning service publishes it under its session lock.
   *
   * It is deliberately the whole round trip rather than a connect: an exit that accepts a stream and
   * then carries nothing is the failure this project keeps meeting, and a check that stops at "the
   * socket opened" would call it healthy (see the relay channel in core/nostr).
   */
  fun measure(socksPort: Int, url: String, nodes: Map<String, Int> = emptyMap()): Check {
    val started = System.nanoTime()
    val result = runCatching { TunnelProbe().fetch(socksPort, url) }
    val took = TunnelProbe.elapsed(started)
    val check = result.fold(
      onSuccess = { measured ->
        // Which node carried it is not guessed: the body of the check is the address the destination
        // saw, and for these exits that is the same machine the plane dials. A node that is not in the
        // map - hy2 only, or an exit whose egress differs from its endpoint - gets no number rather
        // than a number belonging to somebody else.
        val egress = measured.body.trim()
        val legs = Legs(measured.connectMs, measured.tlsMs, measured.answerMs, measured.pingMs,
          nodes[egress]?.let { port -> handshakeMs(egress, port) })
        Check(System.currentTimeMillis(), ok = true, tookMs = measured.tookMs, detail = measured.body, legs = legs)
      },
      onFailure = {
        Check(System.currentTimeMillis(), ok = false, tookMs = took, detail = it.message ?: it.javaClass.simpleName)
      },
    )
    // The legs go to the log and not into summary(): the screen takes the last word of that line as the
    // measurement, and a reading with three more numbers after it would quietly become "278ms".
    if (!check.ok || check.slow) {
      Log.w(TAG, "exit check: ${check.summary()}" + (check.legs?.let { " ($it)" } ?: ""))
    }
    return check
  }

  @Synchronized
  fun record(check: Check) { lastCheck = check }

  /**
   * How long the node takes to answer a TCP handshake - the ping a person means by "ping".
   *
   * Nothing is sent and nothing is read: the socket is opened and closed, which is one round trip on
   * the same path the plane uses and no data at all. It never fails a check - a node that refuses a
   * second connection while happily carrying the first is odd but not broken - so every failure here
   * is simply a missing number.
   */
  private fun handshakeMs(host: String, port: Int): Long? = runCatching {
    val started = System.nanoTime()
    Socket().use { it.connect(InetSocketAddress(host, port), NODE_PING_TIMEOUT_MS) }
    TunnelProbe.elapsed(started)
  }.getOrNull()

  private const val TAG = "magnetgate"
}
