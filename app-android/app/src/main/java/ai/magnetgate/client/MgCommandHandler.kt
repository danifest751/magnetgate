package ai.magnetgate.client

import android.util.Log
import io.nekohasekai.libbox.CommandServerHandler
import io.nekohasekai.libbox.SystemProxyStatus

/**
 * What the engine may ask the app to do. This client owns the tunnel from the service, so there is
 * nothing to hand back: the callbacks exist to complete the interface, and each one says what it does
 * not do rather than silently pretending to.
 */
class MgCommandHandler : CommandServerHandler {

  override fun serviceStop() {
    Log.i(MgVpnService.TAG, "engine asked to stop")
    MgVpnService.requestStop()
  }

  override fun serviceReload() {
    // The configuration is only written when the core restarts, so there is nothing to reload.
  }

  override fun getSystemProxyStatus(): SystemProxyStatus? = null

  override fun setSystemProxyEnabled(enabled: Boolean) = Unit

  override fun connectSSHAgent(): Int = throw UnsupportedOperationException("ssh agent is not used")

  override fun triggerNativeCrash() = Unit

  override fun writeDebugMessage(message: String) {
    Log.d(MgVpnService.TAG, "engine: $message")
  }
}
