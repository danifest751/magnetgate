package ai.magnetgate.client

import org.junit.Assert.*
import org.junit.Test

class NodePingTest {
  @Test fun parsesRepliesWithoutMistakingTimeoutForZeroLatency() {
    assertEquals(163L, NodePing.parse("64 bytes: icmp_seq=1 ttl=54 time=163.130 ms"))
    assertEquals(1L, NodePing.parse("64 bytes: time<1 ms"))
    assertNull(NodePing.parse("1 packets transmitted, 0 received, 100% packet loss"))
    assertNull(NodePing.parse("ping: Operation not permitted"))
  }
  @Test fun acceptsOnlyNumericEndpointAddresses() {
    assertTrue(NodePing.validAddress("192.0.2.1"))
    for (bad in listOf("example.com", "-f", "192.0.2.256", "192.0.2.1;id", "192.0.2"))
      assertFalse(bad, NodePing.validAddress(bad))
  }
}
