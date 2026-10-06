package ai.magnetgate.client

import org.junit.Assert.*
import org.junit.Test

class DiscoveryPreviewTest {
  private class Stand {
    val lock = Any()
    var serviceOwns = false
    var port = 0
    var starts = 0
    var stops = 0
    val preview = DiscoveryPreview(lock, { serviceOwns }, { port },
      { starts++; port = 1000 + starts; port }, { stops++; port = 0 })
  }

  @Test fun findsServersBeforeVpnAndClosesItsOwnCore() {
    val s = Stand()
    val ticket = s.preview.open("config")
    assertNotNull(ticket)
    assertEquals(1, s.starts)
    assertFalse(s.serviceOwns)
    s.preview.close(ticket)
    assertEquals(1, s.stops)
    s.preview.close(ticket)
    assertEquals(1, s.stops)
  }

  @Test fun openingListNeverReplacesRunningOrStartingVpn() {
    val s = Stand()
    s.serviceOwns = true
    s.port = 4000
    assertNull(s.preview.open("config"))
    assertEquals(0, s.starts)
    assertEquals(4000, s.port)
  }

  @Test fun oldScreenCannotStopNewDiscovery() {
    val s = Stand()
    val old = s.preview.open("first")
    val fresh = s.preview.open("second")
    s.preview.close(old)
    assertEquals(0, s.stops)
    assertEquals(1002, s.port)
    s.preview.close(fresh)
    assertEquals(1, s.stops)
  }

  @Test fun vpnTakeoverInvalidatesCleanupEvenWhenPortIsReusedAfterVpn() {
    val s = Stand()
    val old = s.preview.open("config")
    val reusedPort = s.port
    synchronized(s.lock) {
      s.serviceOwns = true
      s.preview.takeover()
      s.port = reusedPort
    }
    s.serviceOwns = false
    s.preview.close(old)
    assertEquals(0, s.stops)
    assertEquals(reusedPort, s.port)
  }

  @Test fun cleanupCannotStopUnrelatedCore() {
    val s = Stand()
    val old = s.preview.open("config")
    s.port = 8000
    s.preview.close(old)
    assertEquals(0, s.stops)
    assertEquals(8000, s.port)
    assertNull(s.preview.open("config"))
  }
}
