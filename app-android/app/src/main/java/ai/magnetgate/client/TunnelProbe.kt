package ai.magnetgate.client

import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URL
import java.util.Timer
import java.util.TimerTask
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** A bounded request through the engine's resolver, independent of the Android UI. */
internal class TunnelProbe(private val timeoutMs: Int = 15_000, private val pingTimeoutMs: Int = 1_500) {
  data class Result(
    val body: String, val tookMs: Long, val connectMs: Long, val tlsMs: Long,
    val answerMs: Long, val pingMs: Long?,
  )

  fun fetch(socksPort: Int, url: String): Result {
    val parsed = URL(url)
    require(parsed.protocol == "http" || parsed.protocol == "https") { "unsupported check protocol" }
    val host = parsed.host
    val port = if (parsed.port != -1) parsed.port else parsed.defaultPort
    val path = parsed.file.ifEmpty { "/" }
    require(!path.contains('\r') && !path.contains('\n')) { "invalid check path" }
    val authority = if (port == parsed.defaultPort) host else "$host:$port"
    val socket = Socket(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort)))
    val timer = Timer("tunnel-probe-deadline", true)
    val expired = java.util.concurrent.atomic.AtomicBoolean(false)
    fun deadline(ms: Int): TimerTask = object : TimerTask() {
      override fun run() { expired.set(true); runCatching { socket.close() } }
    }.also { timer.schedule(it, ms.toLong()) }
    val started = System.nanoTime()
    var expiry = deadline(timeoutMs)
    try {
      socket.use {
        socket.soTimeout = timeoutMs
        socket.connect(InetSocketAddress.createUnresolved(host, port), timeoutMs)
        val connected = System.nanoTime()
        val stream = if (parsed.protocol == "https") {
          ((SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(socket, host, port, true) as SSLSocket).apply {
            soTimeout = timeoutMs
            sslParameters = sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
            startHandshake()
          }
        } else socket
        stream.use {
          val handshaken = System.nanoTime()
          val input = stream.getInputStream().buffered()
          val output = stream.getOutputStream()
          val answer = request(output, input, authority, path, close = false)
          check(answer.body.isNotEmpty()) { "the exit answered with no body" }
          val done = System.nanoTime()
          // The optional round trip cannot extend the primary request's deadline or latency.
          val ping = if (expiry.cancel() && answer.reusable) {
            expiry = deadline(pingTimeoutMs)
            stream.soTimeout = pingTimeoutMs
            runCatching {
              val asked = System.nanoTime()
              request(output, input, authority, path, close = true)
              elapsed(asked)
            }.getOrNull()
          } else null
          return Result(answer.body.take(64), millis(done - started), millis(connected - started),
            millis(handshaken - connected), millis(done - handshaken), ping)
        }
      }
    } catch (error: java.io.IOException) {
      if (expired.get()) throw SocketTimeoutException("exit check deadline exceeded (${timeoutMs}ms)")
        .apply { initCause(error) }
      throw error
    } finally {
      expiry.cancel()
      timer.cancel()
      socket.close()
    }
  }

  private data class Answer(val body: String, val reusable: Boolean)

  private fun request(output: OutputStream, input: InputStream, host: String, path: String, close: Boolean): Answer {
    output.write(("GET $path HTTP/1.1\r\nHost: $host\r\n" +
      "Connection: ${if (close) "close" else "keep-alive"}\r\nUser-Agent: magnetgate/1.0\r\n\r\n")
      .toByteArray(Charsets.US_ASCII))
    output.flush()
    val status = line(input)
    check(Regex("HTTP/1\\.[01] 200(?: .*|)").matches(status)) { status.ifEmpty { "no status line" } }
    var headerBytes = status.length
    var length: Int? = null
    var chunked = false
    var connectionClose = false
    while (true) {
      val header = line(input)
      headerBytes += header.length + 2
      check(headerBytes <= MAX_HEADERS) { "check headers too large" }
      if (header.isEmpty()) break
      val value = header.substringAfter(':').trim()
      when (header.substringBefore(':').trim().lowercase()) {
        "content-length" -> {
          val size = value.toIntOrNull()
          check(size != null && size in 0..MAX_BODY && (length == null || length == size)) { "invalid check body length" }
          length = size
        }
        "transfer-encoding" -> {
          check(value.equals("chunked", ignoreCase = true)) { "unsupported check transfer encoding" }
          chunked = true
        }
        "connection" -> connectionClose = value.equals("close", ignoreCase = true)
      }
    }
    check(!(chunked && length != null)) { "ambiguous check body framing" }
    val body = java.io.ByteArrayOutputStream()
    if (chunked) {
      while (true) {
        val size = line(input).substringBefore(';').trim().toIntOrNull(16)
        check(size != null && size in 0..(MAX_BODY - body.size())) { "invalid check chunk length" }
        if (size == 0) {
          var trailerBytes = 0
          while (true) {
            val trailer = line(input)
            trailerBytes += trailer.length + 2
            check(trailerBytes <= MAX_HEADERS) { "check trailers too large" }
            if (trailer.isEmpty()) break
          }
          break
        }
        repeat(size) { body.write(byte(input)) }
        check(line(input).isEmpty()) { "invalid check chunk ending" }
      }
    } else if (length != null) {
      repeat(length) { body.write(byte(input)) }
    } else {
      while (true) {
        val value = input.read()
        if (value < 0) break
        check(body.size() < MAX_BODY) { "check body too large" }
        body.write(value)
      }
    }
    return Answer(body.toString("UTF-8").trim(), (chunked || length != null) && !connectionClose)
  }

  private fun byte(input: InputStream): Int = input.read().also {
    check(it >= 0) { "the answer ended before its body was complete" }
  }

  private fun line(input: InputStream): String {
    val bytes = java.io.ByteArrayOutputStream()
    while (true) {
      val value = byte(input)
      if (value == 10) break
      check(bytes.size() < MAX_HEADERS) { "check header line too large" }
      bytes.write(value)
    }
    return bytes.toString("US-ASCII").removeSuffix("\r")
  }

  companion object {
    private const val MAX_HEADERS = 8_192
    private const val MAX_BODY = 1_024
    private fun millis(nanos: Long) = nanos / 1_000_000
    fun elapsed(started: Long) = millis(System.nanoTime() - started)
  }
}
