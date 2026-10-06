package ai.magnetgate.client

/** Serializes native changes and invalidates work prepared before Disconnect. */
internal class TunnelSession(private val lock: Any = Any()) {
  private var generation = 0L
  private var active = false
  private var worker: Thread? = null

  fun begin(): Long? = synchronized(lock) {
    if (active) null else { active = true; ++generation }
  }

  fun attach(ticket: Long, thread: Thread) = use(ticket) { worker = thread }

  fun current(ticket: Long): Boolean = synchronized(lock) { active && generation == ticket }

  /** Queued callbacks and finished measurements may publish only to their original session. */
  fun commit(ticket: Long, action: () -> Unit): Boolean = synchronized(lock) {
    if (!active || generation != ticket) false else { action(); true }
  }

  fun <T> use(ticket: Long, action: () -> T): T = synchronized(lock) {
    if (!active || generation != ticket) throw InterruptedException("tunnel start cancelled")
    action()
  }

  fun stop(ticket: Long? = null, cleanup: () -> Unit) = synchronized(lock) {
    if (!active || (ticket != null && generation != ticket)) return@synchronized
    active = false
    generation++
    worker?.takeIf { it != Thread.currentThread() }?.interrupt()
    worker = null
    cleanup()
  }
}
