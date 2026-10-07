package ai.magnetgate.client

import org.junit.Assert.assertEquals
import org.junit.Test

class EngineTrafficTest {
  @Test fun recoveryKeepsTotalsAndRejectsStaleResponses() {
    val counter = EngineTraffic()
    val first = EngineTraffic.Endpoint(1234, "first")
    counter.attach(first.port, first.secret, true)
    counter.accept(first, EngineTraffic.Totals(100, 400))
    counter.accept(first, EngineTraffic.Totals(100, 400))
    counter.accept(first, EngineTraffic.Totals(130, 900))
    assertEquals(EngineTraffic.Totals(130, 900), counter.totals)
    val second = EngineTraffic.Endpoint(1235, "second")
    counter.attach(second.port, second.secret)
    counter.accept(first, EngineTraffic.Totals(9000, 9000))
    counter.accept(second, EngineTraffic.Totals(20, 30))
    assertEquals(EngineTraffic.Totals(150, 930), counter.totals)
    counter.attach(1236, "new session", true)
    assertEquals(EngineTraffic.Totals(), counter.totals)
  }
}
