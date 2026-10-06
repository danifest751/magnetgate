package ai.magnetgate.client

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class PeerStatusTest {
  @Test fun peerTrafficReachesTheScreenWithoutLegacyCoreCounters() {
    val status = PeerRuntime.view(JSONObject("""{"guestConnected":true,"guestCountry":"FI","sent":12345,"received":98765} """))
    assertEquals(12345L, status.sent)
    assertEquals(98765L, status.received)
    assertEquals("FI", status.country)
  }
}
