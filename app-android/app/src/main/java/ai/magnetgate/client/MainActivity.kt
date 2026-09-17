package ai.magnetgate.client

import android.Manifest
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import ai.magnetgate.core.mgbox.Mgbox
import java.io.File

private const val TAG = "magnetgate"

/**
 * The activity is a shell: it reads the launch extras (which exist for the acceptance scripts), hands the
 * screens their initial parameters, and answers the `dump` hook. Everything else lives in the screens
 * (`AppUi`) and in the service that owns the tunnel.
 */
class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val extras = intent
    if (extras?.getStringExtra("dump") == "true") {
      dumpStatus()
      return
    }
    if (extras?.getStringExtra("stop") == "true") {
      if (debuggable()) stopTunnel() else Log.w(TAG, "the stop hook only exists in debuggable builds")
      return
    }
    if (extras?.getStringExtra("kill") == "true") {
      if (debuggable()) killProcess() else Log.w(TAG, "the kill hook only exists in debuggable builds")
      return
    }
    val autotest =
      extras?.getStringExtra("autotest") == "true" || extras?.getBooleanExtra("autotest", false) == true
    Log.i(TAG, "app started, core ${Mgbox.coreVersion()}, autotest=$autotest")

    // not during an acceptance run: the permission dialog takes the foreground, and a script that
    // cannot tap it would be left measuring a tunnel that never started
    if (!autotest) askForNotifications()

    // `-e save true` writes the discovery extras into the settings store instead of applying them to
    // this launch only, so a device can be provisioned from the command line rather than typed into on
    // a phone keyboard. Done here, before the screens read the store, and once per intent rather than
    // once per recomposition. The PSK is deliberately not accepted this way: an intent extra is visible
    // to other applications and in logs, and it already reaches the Keystore through files/psk.txt.
    if (extras?.getStringExtra("save") == "true") {
      extras.getStringExtra("bootstrap")?.takeIf { it.isNotBlank() }?.let { Settings.setBootstrap(this, it) }
      extras.getStringExtra("relays")?.takeIf { it.isNotBlank() }?.let { Settings.setRelays(this, it) }
      extras.getStringExtra("slots")?.takeIf { it.isNotBlank() }
        ?.let { Settings.setSlots(this, Settings.parseSlots(it)) }
      extras.getStringExtra("mode")?.takeIf { it.isNotBlank() }
        ?.let { Settings.setMode(this, Settings.Mode.of(it)) }
      Log.i(TAG, "settings saved from extras: bootstrap/relays/slots/mode")
    }
    setContent {
      MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
          AppRoot(
            autotest = autotest,
            vpn = extras?.getStringExtra("vpn") == "true",
            coreless = extras?.getStringExtra("coreless") == "true",
            bootstrapExtra = extras?.getStringExtra("bootstrap").orEmpty(),
            relaysExtra = extras?.getStringExtra("relays").orEmpty(),
            checkUrlExtra = extras?.getStringExtra("checkurl").orEmpty(),
            modeExtra = extras?.getStringExtra("mode").orEmpty(),
          )
        }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // the app is usually already running when someone wants its state, so the dump hook has to work here
    // and not only in onCreate
    if (intent.getStringExtra("dump") == "true") dumpStatus()
    if (intent.getStringExtra("stop") == "true" && debuggable()) stopTunnel()
    if (intent.getStringExtra("kill") == "true" && debuggable()) killProcess()
  }

  /**
   * Whether this build may be driven from a shell.
   *
   * The launcher activity is exported, so an extra that takes the tunnel down - or kills the process
   * carrying it - is reachable by anything on the phone that can send an intent. In a release build that
   * would be a way for another app to switch someone's VPN off, which is the opposite of what a tunnel
   * with a lockdown is for. These hooks therefore exist only where a debugger could attach anyway.
   */
  private fun debuggable(): Boolean =
    (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  /**
   * Ends this process the way the system would, without an application crash.
   *
   * `am crash` is not the same thing on this ROM: it is delivered as a crash, MIUI files a report and
   * raises its "application stopped" dialog, and the service restart waits behind that dialog for a
   * person - so a run that uses it measures the dialog rather than the recovery. Killing the process is
   * what an out-of-memory kill or a native crash looks like from the system's side, which is the death
   * the fail-closed promise actually has to survive.
   */
  private fun killProcess() {
    Log.w(TAG, "killing this process on request (the acceptance run measures what comes back)")
    android.os.Process.killProcess(android.os.Process.myPid())
  }

  /**
   * Brings the tunnel down on request, the same way the Disconnect button does.
   *
   * `adb` cannot reach [MgVpnService] - it is not exported, and nothing that is reachable from a shell
   * should be able to take someone's tunnel down. An acceptance run still has to check what Disconnect
   * releases: the tun leak of 16.09 was interfaces and routes outliving "tunnel down", and that is
   * invisible unless something brings the tunnel down and then looks.
   */
  private fun stopTunnel() {
    Log.i(TAG, "stop requested through the launch extra")
    startService(Intent(this, MgVpnService::class.java).setAction(MgVpnService.ACTION_STOP))
  }

  /**
   * Asks for the notification permission, which from Android 13 is not granted by declaring it.
   *
   * Without it the foreground service still runs, but its card never appears in the shade - so the one
   * place a person would look to see whether the tunnel is up, and the only place this app can say
   * something while it is not on screen, is simply missing. The permission was declared in the manifest
   * and never requested, which looked like it worked on anything older.
   */
  private fun askForNotifications() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
    if (granted) return
    // registerForActivityResult has to be created before the activity is started, which is why this is
    // built here in onCreate rather than where it is used
    val ask = registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
      Log.i(TAG, "notifications ${if (allowed) "allowed" else "refused"}")
    }
    ask.launch(Manifest.permission.POST_NOTIFICATIONS)
  }

  /**
   * Writes what the core currently reports to the app's files directory: the diagnostics screen and the
   * acceptance scripts both want it, and the core's log ring only exists in this process.
   */
  private fun dumpStatus() {
    val status = runCatching { Mgbox.coreStatus() }.getOrElse { "status failed: ${it.message}" }
    runCatching { File(filesDir, "status.txt").writeText(status) }
    // The health of the tunnel lives in this process and nowhere else, so without this line the only
    // way to see whether the exit is answering is to look at the screen - and a check that needs a
    // human looking at a screen cannot be part of an acceptance run.
    val health = Health.lastCheck
    val line = buildString {
      append(if (health == null) "check=none" else "check=${if (health.ok) "ok" else "failed"} took=${health.tookMs}ms at=${health.atMs} detail=${health.detail}")
      if (Health.engineError.isNotEmpty()) append(" engineError=${Health.engineError}")
    }
    runCatching { File(filesDir, "health.txt").writeText(line) }
    Log.i(TAG, "status dumped ($line)")
  }
}
