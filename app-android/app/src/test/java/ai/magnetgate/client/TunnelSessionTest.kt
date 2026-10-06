package ai.magnetgate.client

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class TunnelSessionTest {
  @Test fun queuedCallbacksAndMeasurementsCannotPublishIntoReplacementSession() {
    val session = TunnelSession()
    val old = session.begin()!!
    val prepared = CountDownLatch(1)
    val release = CountDownLatch(1)
    val done = CountDownLatch(1)
    var networkUpdates = 0
    val stale = Health.Check(1, true, 10, "old result")
    val worker = Thread {
      prepared.countDown()
      release.await()
      session.commit(old) { networkUpdates++; Health.record(stale) }
      done.countDown()
    }
    worker.start()
    assertTrue(prepared.await(2, TimeUnit.SECONDS))
    session.stop { Health.reset() }
    val current = session.begin()!!
    val fresh = Health.Check(2, false, 20, "new result")
    assertTrue(session.commit(current) { Health.record(fresh) })
    release.countDown()
    assertTrue(done.await(2, TimeUnit.SECONDS))
    assertEquals(0, networkUpdates)
    assertEquals(fresh, Health.lastCheck)
    session.stop { Health.reset() }
  }
  @Test fun cancelledPreparationCannotCommitOrStopReplacement() {
    val session = TunnelSession()
    val old = session.begin()!!
    val prepared = CountDownLatch(1)
    val release = CountDownLatch(1)
    val done = CountDownLatch(1)
    var commits = 0
    val worker = Thread {
      prepared.countDown()
      // Model a native preparation operation which does not respond to interruption.
      while (true) {
        try { release.await(); break } catch (_: InterruptedException) { }
      }
      try { session.use(old) { commits++ } } catch (_: InterruptedException) { }
      session.stop(old) { commits += 100 }
      done.countDown()
    }
    session.attach(old, worker)
    worker.start()
    assertTrue(prepared.await(2, TimeUnit.SECONDS))
    session.stop { }
    val replacement = session.begin()!!
    release.countDown()
    assertTrue(done.await(2, TimeUnit.SECONDS))
    assertEquals(0, commits)
    assertTrue(session.current(replacement))
    assertNull(session.begin())
    session.stop { }
  }

  @Test fun stopWaitsForNativeCommitAndThenClosesIt() {
    val session = TunnelSession()
    val ticket = session.begin()!!
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val stopped = CountDownLatch(1)
    val events = mutableListOf<String>()
    val worker = Thread { session.use(ticket) {
      entered.countDown()
      release.await()
      events.add("start")
    } }
    worker.start()
    assertTrue(entered.await(2, TimeUnit.SECONDS))
    val stopper = Thread { session.stop { events.add("stop") }; stopped.countDown() }
    stopper.start()
    assertFalse(stopped.await(50, TimeUnit.MILLISECONDS))
    release.countDown()
    assertTrue(stopped.await(2, TimeUnit.SECONDS))
    assertEquals(listOf("start", "stop"), events)
    assertFalse(session.current(ticket))
  }
}
