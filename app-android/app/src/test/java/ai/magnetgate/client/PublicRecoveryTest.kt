package ai.magnetgate.client

import org.junit.Assert.*
import org.junit.Test

class PublicRecoveryTest {
  @Test fun retriesOneFailureThenMovesAwayFromLastWorkingNode() {
    val recovery = PublicRecovery()
    assertNull(recovery.observe(true, 1, listOf(0, 1), 0))
    assertNull(recovery.observe(false, null, listOf(0, 1), 5000))
    assertEquals(0, recovery.observe(false, null, listOf(0, 1), 10000))
    assertNull(recovery.observe(true, 0, listOf(0, 1), 15000))
    assertNull(recovery.observe(false, null, listOf(0, 1), 45000))
    assertEquals(1, recovery.observe(false, null, listOf(0, 1), 50000))
  }

  @Test fun cooldownPreventsRestartLoopsAndRecoveryKeepsItsNode() {
    val recovery = PublicRecovery()
    assertNull(recovery.observe(false, null, listOf(0, 1), 0))
    assertEquals(0, recovery.observe(false, null, listOf(0, 1), 5000))
    repeat(4) { assertNull(recovery.observe(false, null, listOf(0, 1), 10000L + it * 5000)) }
    assertEquals(1, recovery.observe(false, null, listOf(0, 1), 35000))
    assertNull(recovery.observe(true, 1, listOf(0, 1), 40000))
    assertNull(recovery.observe(false, null, emptyList(), 80000))
  }
}
