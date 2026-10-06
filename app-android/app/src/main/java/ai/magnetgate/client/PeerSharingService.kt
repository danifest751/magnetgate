package ai.magnetgate.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import ai.magnetgate.core.mgbox.Mgbox
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Explicit consent, never restored by watchdog, reboot or START_STICKY. */
class PeerSharingService : Service() {
  companion object {
    private const val CHANNEL = "peer-sharing"
    private const val ID = 3
    private const val STOP = "ai.magnetgate.client.peer.STOP"
    private const val POLICY = "policy"
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private val consentLock = Any()
    fun apply(context: Context, policy: JSONObject) {
      val intent = Intent(context, PeerSharingService::class.java).putExtra(POLICY, policy.toString())
      if (policy.optBoolean("enabled")) context.startForegroundService(intent)
      else context.startService(intent.setAction(STOP))
    }
  }
  private var poll: java.util.concurrent.ScheduledFuture<*>? = null
  private var wake: PowerManager.WakeLock? = null
  @Volatile private var alive = false
  @Volatile private var generation = 0L
  override fun onCreate() {
    super.onCreate()
    alive = true
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.peer_share_title), NotificationManager.IMPORTANCE_LOW))
    poll = worker.scheduleWithFixedDelay({
      if (!alive) return@scheduleWithFixedDelay
      val active = PeerRuntime.status().optBoolean("sharing")
      if (active) {
        if (wake == null) wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MagnetGate:sharing").apply { setReferenceCounted(false) }
        wake?.acquire(60_000)
      } else releaseWake()
      Handler(Looper.getMainLooper()).post {
        if (alive) manager.notify(ID, notification(if (active) R.string.peer_share_ready else R.string.peer_share_paused))
      }
    }, 15, 15, TimeUnit.SECONDS)
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val stopping = intent == null || intent.action == STOP
    val ticket = synchronized(consentLock) {
      generation++
      if (stopping) PeerRuntime.sharingRequested = false
      generation
    }
    if (stopping) {
      worker.execute { disable(); if (generation == ticket) stopSelfResult(startId) }
      return START_NOT_STICKY
    }
    startForeground(ID, notification(R.string.peer_share_paused))
    val value = intent.getStringExtra(POLICY) ?: ""
    worker.execute {
      try {
        PeerRuntime.ensure(this)
        val policy = JSONObject(value)
        check(policy.optBoolean("enabled"))
        synchronized(PeerRuntime.sharingLock) {
          synchronized(consentLock) {
            if (!alive || generation != ticket) return@execute
            PeerRuntime.sharingRequested = true
          }
          PeerRuntime.setPolicy(policy)
          PeerRuntime.sharingError = false
        }
      } catch (_: Exception) {
        PeerRuntime.sharingError = true
        disable()
        if (generation == ticket) stopSelfResult(startId)
      }
    }
    return START_NOT_STICKY
  }
  private fun disable() {
    PeerRuntime.sharingRequested = false
    synchronized(PeerRuntime.sharingLock) {
      Mgbox.suspendPeerExit()
      val policy = PeerRuntime.status().optJSONObject("policy")
      if (policy != null) runCatching { Mgbox.setPeerPolicy(policy.put("enabled", false).toString()) }
    }
    releaseWake()
  }
  private fun releaseWake() { wake?.let { if (it.isHeld) it.release() }; wake = null }
  private fun notification(text: Int): Notification {
    val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val stop = PendingIntent.getService(this, 0, Intent(this, PeerSharingService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    return Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_globe)
      .setContentTitle(getString(R.string.peer_share_title)).setContentText(getString(text))
      .setContentIntent(open).setOngoing(true).addAction(Notification.Action.Builder(null, getString(R.string.peer_share_stop), stop).build()).build()
  }
  override fun onDestroy() {
    synchronized(consentLock) {
      alive = false
      generation++
      PeerRuntime.sharingRequested = false
    }
    poll?.cancel(false)
    worker.execute { disable() }
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }
  override fun onBind(intent: Intent?): IBinder? = null
}
