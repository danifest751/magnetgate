package ai.magnetgate.client

import org.junit.Assert.*
import org.junit.Test
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class TunnelProbeTest {
  private fun fixture(action: (Socket) -> Unit, verify: (Int) -> Unit) {
    ServerSocket(0).use { server ->
      val done = CountDownLatch(1)
      val failure = java.util.concurrent.atomic.AtomicReference<Throwable>()
      val worker = Thread {
        try { server.accept().use { socket ->
          socket.soTimeout = 2_000
          val input = socket.getInputStream()
          val output = socket.getOutputStream()
          check(input.read() == 5)
          val methods = input.read()
          repeat(methods) { input.read() }
          output.write(byteArrayOf(5, 0)); output.flush()
          check(input.read() == 5); check(input.read() == 1); input.read()
          check(input.read() == 3) // The probe must leave DNS to the engine.
          repeat(input.read()) { input.read() }; input.read(); input.read()
          output.write(byteArrayOf(5, 0, 0, 1, 127, 0, 0, 1, 0, 80)); output.flush()
          action(socket)
        } } catch (_: java.io.IOException) { } catch (error: Throwable) {
          failure.set(error)
        } finally { done.countDown() }
      }
      worker.start()
      try { verify(server.localPort) } finally {
        server.close()
        assertTrue("fixture leaked", done.await(3, TimeUnit.SECONDS))
        failure.get()?.let { throw it }
      }
    }
  }

  private fun readRequest(socket: Socket): String {
    val reader = socket.getInputStream().bufferedReader()
    val lines = mutableListOf<String>()
    while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break; lines.add(line) }
    return lines.joinToString("\n")
  }

  @Test fun stalledOptionalPingDoesNotInflateSuccessfulLatency() = fixture({ socket ->
    assertTrue(readRequest(socket).startsWith("GET /?format=text HTTP/1.1"))
    socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n127.0.0.1".toByteArray())
    readRequest(socket)
    while (socket.getInputStream().read() >= 0) { }
  }) { port ->
    val before = System.nanoTime()
    val result = TunnelProbe(1_000, 200).fetch(port, "http://example.test/?format=text")
    assertEquals("127.0.0.1", result.body)
    assertNull(result.pingMs)
    assertTrue(result.tookMs < 200)
    assertTrue(TunnelProbe.elapsed(before) < 1_000)
  }

  @Test fun stalledTlsHandshakeHasTotalDeadline() = fixture({ socket ->
    while (socket.getInputStream().read() >= 0) { }
  }) { port ->
    val before = System.nanoTime()
    assertThrows(Exception::class.java) { TunnelProbe(300).fetch(port, "https://example.test/") }
    assertTrue(TunnelProbe.elapsed(before) < 1_500)
  }

  @Test fun dripFedHeadersCannotExtendTotalDeadline() = fixture({ socket ->
    readRequest(socket)
    repeat(100) { socket.getOutputStream().write('H'.code); Thread.sleep(20) }
  }) { port ->
    val before = System.nanoTime()
    assertThrows(Exception::class.java) { TunnelProbe(250).fetch(port, "http://example.test/") }
    assertTrue(TunnelProbe.elapsed(before) < 1_000)
  }

  @Test fun chunkedAnswerIsDecoded() = fixture({ socket ->
    readRequest(socket)
    socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n" +
      "9\r\n127.0.0.1\r\n0\r\n\r\n").toByteArray())
  }) { port -> assertEquals("127.0.0.1", TunnelProbe().fetch(port, "http://example.test/").body) }

  @Test fun oversizedAndTruncatedAnswersAreRejected() {
    for (response in listOf("HTTP/1.1 200 OK\r\nContent-Length: 2147483647\r\n\r\n",
      "HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n127")) {
      fixture({ socket -> readRequest(socket); socket.getOutputStream().write(response.toByteArray()) }) { port ->
        assertThrows(Exception::class.java) { TunnelProbe().fetch(port, "http://example.test/") }
      }
    }
  }
}
