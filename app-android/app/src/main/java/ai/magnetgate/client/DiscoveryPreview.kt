package ai.magnetgate.client

import ai.magnetgate.core.mgbox.Mgbox

/** A screen may discover countries, but may never replace or stop a VPN-owned core. */
internal class DiscoveryPreview(
  private val lock: Any,
  private val serviceOwnsCore: () -> Boolean,
  private val livePort: () -> Int,
  private val start: (String) -> Int,
  private val stop: () -> Unit,
) {
  private var owner: Any? = null
  private var port = 0

  fun open(config: String): Any? = synchronized(lock) {
    if (serviceOwnsCore()) return@synchronized null
    if (owner == null && livePort() != 0) return@synchronized null
    port = start(config)
    check(port > 0) { "Discovery did not start" }
    Any().also { owner = it }
  }

  fun close(ticket: Any?) = synchronized(lock) {
    if (ticket == null || owner !== ticket) return@synchronized
    owner = null
    if (!serviceOwnsCore() && livePort() == port) stop()
    port = 0
  }

  /** Starting a VPN transfers responsibility for native teardown to the service. */
  fun takeover() = synchronized(lock) { owner = null; port = 0 }
}

internal object CountryDiscovery {
  private val preview = DiscoveryPreview(MgVpnService.nativeLock, MgVpnService::ownsCore,
    { CoreStatus.parse(Mgbox.coreStatus()).socksPort },
    { Mgbox.startCore(it).toInt() }, { Mgbox.stopCore() })
  fun open(config: String) = preview.open(config)
  fun close(ticket: Any?) = preview.close(ticket)
  fun takeover() = preview.takeover()
}
