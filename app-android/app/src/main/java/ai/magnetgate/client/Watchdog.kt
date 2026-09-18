package ai.magnetgate.client

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.util.Log

/**
 * The thing that brings the tunnel back after the process carrying it dies.
 *
 * Measured four times on the owner's phone (three `am crash`, one honest kill): 150-211 seconds without
 * a process and without a route, and not one recovery. With the VPN lockdown on, that is a phone with no
 * network until a person opens the app - so the fail-closed promise was only half kept: the network
 * closed honestly and came back by hand.
 *
 * Two mechanisms were tried first and neither is one:
 *
 * - `START_STICKY` - the system does not act on it here; the log shows `PowerKeeper.Vpn: removed vpn`,
 *   `unbindService` and then silence, with no line about scheduling a restart;
 * - always-on VPN - it honestly covers **boot** (10 s after a reboot, measured) and nothing else. It is
 *   the system binding a service, not a promise to bind it again when the process is gone.
 *
 * What does survive a process death is work the system holds on our behalf. A job is exactly that: the
 * record lives in the system, the process is started to run it, and killing the app does not remove it.
 * So this is a job that wakes up, asks whether the tunnel should be up, and starts it if it is not.
 *
 * It is a watchdog, not a health check. "Up" here means the service exists and holds a tunnel; whether
 * that tunnel carries anything is measured by [Health] inside it, on its own schedule.
 */
object Watchdog {
  private const val TAG = "magnetgate"

  /**
   * The wish, kept apart from [Settings] on purpose.
   *
   * [Settings] is an `EncryptedSharedPreferences` whose master key lives in the Keystore, and this flag
   * has to be readable in the worst minute this app has: straight after a process death, possibly before
   * a user has unlocked the phone since boot, on a device whose Keystore is the one thing the settings
   * store already admits can fail. It is also not a secret - it says that someone pressed Connect, which
   * the notification in the shade says louder.
   */
  private const val FILE = "magnetgate-watchdog"
  private const val KEY_WANTED = "wanted"

  private const val JOB_ID = 0x4d47

  /**
   * How long the phone may stay without a tunnel.
   *
   * The outages this answers were 150-211 s, so a minute is the difference between "it came back on its
   * own" and "it never came back". A tick costs a boolean read and, while the tunnel is up, nothing
   * else: the process is already running, because it is carrying the VPN.
   */
  private const val PERIOD_MS = 60_000L

  private fun store(context: Context) =
    context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  /** Whether the tunnel is meant to be up - the last thing a person asked for, not what is running. */
  fun wanted(context: Context): Boolean = store(context).getBoolean(KEY_WANTED, false)

  /**
   * Records what was asked for and puts the watch in place, or takes it away.
   *
   * Disconnect has to remove the job, not only the tunnel: a watchdog that outlives the wish would
   * reconnect a VPN the user just switched off, which is the one thing a VPN client must never do.
   */
  fun want(context: Context, wanted: Boolean) {
    store(context).edit().putBoolean(KEY_WANTED, wanted).apply()
    if (wanted) schedule(context) else cancel(context)
  }

  /**
   * Asks the system to wake this app in [PERIOD_MS].
   *
   * One-shot and rescheduled on every tick rather than periodic: the shortest period the system accepts
   * is 15 minutes, which for this defect means a quarter of an hour of a phone with no network.
   *
   * Persisted, so a reboot is covered by the same mechanism as a crash. Always-on VPN also covers a
   * reboot, but it is switched on in system settings and can be switched off there without anything in
   * this app noticing.
   *
   * ⚠️ No network constraint. Under the lockdown, "the tunnel is down" *is* "this phone has no network",
   * so a job that waits for connectivity would wait exactly as long as the outage lasts and never run.
   */
  fun schedule(context: Context) {
    val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
    val job = JobInfo.Builder(JOB_ID, ComponentName(context, WatchdogJob::class.java))
      .setMinimumLatency(PERIOD_MS)
      .setPersisted(true)
      .build()
    val result = runCatching { scheduler.schedule(job) }
      .onFailure { Log.w(TAG, "watchdog: the system refused the job: ${it.message}") }
      .getOrDefault(JobScheduler.RESULT_FAILURE)
    if (result != JobScheduler.RESULT_SUCCESS) Log.w(TAG, "watchdog: the job was not scheduled")
  }

  private fun cancel(context: Context) {
    runCatching { context.getSystemService(JobScheduler::class.java)?.cancel(JOB_ID) }
      .onFailure { Log.w(TAG, "watchdog: cancelling the job: ${it.message}") }
  }
}

/**
 * One tick of [Watchdog]: is the tunnel meant to be up, and is it?
 *
 * It runs on the main thread and returns immediately, because everything it does is cheap and the work
 * that is not - discovery, the engine - belongs to the service it starts.
 */
class WatchdogJob : JobService() {
  override fun onStartJob(params: JobParameters?): Boolean {
    if (!Watchdog.wanted(this)) {
      // Nothing to watch. The job is not rescheduled, which is how the watch ends after a Disconnect
      // that happened while this tick was already on its way.
      Log.i(MgVpnService.TAG, "watchdog: the tunnel is not wanted; standing down")
      return false
    }
    // First, so that the next tick exists no matter what the rest of this does - including throwing.
    Watchdog.schedule(this)
    if (MgVpnService.isRunning() || MgVpnService.ownsCore()) return false

    // Consent is a grant to this app, and it survives a crash; if it is gone the user revoked the VPN or
    // another app took it over, and nothing here may put up a dialog to ask again from the background.
    if (VpnService.prepare(this) != null) {
      Log.w(MgVpnService.TAG, "watchdog: the tunnel is wanted but this app is no longer the VPN")
      return false
    }
    Log.w(MgVpnService.TAG, "watchdog: the tunnel is wanted and not up; starting it")
    runCatching {
      startForegroundService(Intent(this, MgVpnService::class.java).setAction(MgVpnService.ACTION_START))
    }.onFailure {
      // Android 12+ refuses a foreground service started from the background unless the app is exempt;
      // the exemption this relies on is the battery-optimisation one the owner already granted. If that
      // is taken away the tunnel stops coming back, and this line is the only place that would say so.
      Log.e(MgVpnService.TAG, "watchdog: the system refused to start the tunnel: ${it.message}")
    }
    return false
  }

  /** Nothing is left running when the tick is cut short, so there is nothing to reschedule. */
  override fun onStopJob(params: JobParameters?): Boolean = false
}
