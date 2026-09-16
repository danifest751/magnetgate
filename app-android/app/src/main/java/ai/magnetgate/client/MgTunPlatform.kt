package ai.magnetgate.client

import ai.magnetgate.core.mgbox.PlatformHandler
import org.json.JSONObject

/**
 * The two things the engine asks the platform for, and nothing else: a tunnel and socket protection.
 *
 * Everything else the engine can ask for is answered inside the binding with an explicit default, so the
 * app carries no boilerplate for features it does not offer. The tun itself is built by the service (only
 * a VpnService may configure one) from the request the engine sends.
 */
class MgTunPlatform(private val service: MgVpnService) : PlatformHandler {

  /** The request is the JSON form of the engine's tun options. */
  override fun openTun(requestJson: String): Int = service.establishTun(JSONObject(requestJson))

  /** Called for each of the engine's own sockets, so they leave the device instead of looping back. */
  override fun protect(fd: Int) {
    if (!service.protect(fd)) {
      throw IllegalStateException("VpnService.protect($fd) failed")
    }
  }
}
