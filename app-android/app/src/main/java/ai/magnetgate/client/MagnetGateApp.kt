package ai.magnetgate.client

import android.app.Application

/**
 * The first thing in this process to run, and the only reason it exists: to be there before anything
 * can fail.
 *
 * A crash handler installed by an activity misses everything that happens before the activity - which
 * is most of what this application does, because the tunnel lives in a service that the system starts
 * on its own. So it is installed here, where the process begins, whatever started it: the launcher, the
 * watchdog's job, or always-on VPN after a reboot.
 */
class MagnetGateApp : Application() {
  override fun onCreate() {
    super.onCreate()
    Reports.catchCrashes(this)
  }
}
