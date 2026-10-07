package ai.magnetgate.client

/** Retry a transient failure, then rebuild on another node; never fall back to direct traffic. */
internal class PublicRecovery {
  private var failures = 0
  private var lastRestart = Long.MIN_VALUE
  private var lastNode: Int? = null

  fun observe(ok: Boolean, node: Int?, available: List<Int>, nowMs: Long): Int? {
    if (ok) {
      failures = 0
      if (node != null) lastNode = node
      return null
    }
    failures++
    if (failures < 2 || available.isEmpty()) return null
    if (lastRestart != Long.MIN_VALUE && nowMs - lastRestart < 30_000) return null
    val next = available.firstOrNull { it != lastNode } ?: available.first()
    lastNode = next
    lastRestart = nowMs
    failures = 0
    return next
  }
}
