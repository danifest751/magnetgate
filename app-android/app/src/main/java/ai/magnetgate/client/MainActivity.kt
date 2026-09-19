package ai.magnetgate.client

import android.Manifest
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
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

/** How long the activity is given to go away before the process behind it is ended; see `killProcess`. */
private const val KILL_DELAY_MS = 3_000L

/**
 * The activity is a shell: it reads the launch extras (which exist for the acceptance scripts), hands the
 * screens their initial parameters, and answers the `dump` hook. Everything else lives in the screens
 * (`AppUi`) and in the service that owns the tunnel.
 */
class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Цвет системных значков следует за темой; отступы учитывает AppRoot.
    enableEdgeToEdge()
    val extras = intent
    if (extras?.getStringExtra("dump") == "true") {
      dumpStatus()
      return
    }
    if (extras?.getStringExtra("stop") == "true") {
      if (fromShell()) stopTunnel() else Log.w(TAG, "the stop hook is for adb on a debuggable build, and this launch is neither")
      return
    }
    if (extras?.getStringExtra("kill") == "true") {
      if (fromShell()) killProcess() else Log.w(TAG, "the kill hook is for adb on a debuggable build, and this launch is neither")
      return
    }
    // `-e report true` writes one synthetic report, so a run can prove both halves of the switch: that
    // a report is written and sent when it is on, and that nothing reaches the disk when it is off. A
    // real crash cannot be used for that here - `am crash` is filed by MIUI and raises its own dialog.
    if (extras?.getStringExtra("report") == "true") {
      if (fromShell()) {
        Reports.write(this, IllegalStateException("synthetic report requested over adb"), "hook")
        Log.i(TAG, "report hook: enabled=${Reports.enabled(this)} waiting=${Reports.pending(this).size}")
      } else {
        Log.w(TAG, "the report hook is for adb on a debuggable build, and this launch is neither")
      }
      return
    }
    extras?.getStringExtra("update")?.takeIf { it.isNotBlank() }?.let { Updates.inject(it, fromShell()) }
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
      // `any` rather than an empty string, because an empty extra is indistinguishable from an absent
      // one and "no preference" has to be sayable from a command line.
      extras.getStringExtra("country")?.takeIf { it.isNotBlank() }
        ?.let { Settings.setCountry(this, if (it.equals("any", ignoreCase = true)) "" else it) }
      extras.getStringExtra("apps")?.takeIf { it.isNotBlank() }
        ?.let { Settings.setApps(this, Settings.Apps.of(it)) }
      // `none` clears the list, for the same reason `any` clears the country: an empty extra cannot be
      // told apart from an absent one, and a run has to be able to put the phone back as it found it.
      extras.getStringExtra("packages")?.takeIf { it.isNotBlank() }?.let { value ->
        val packages = if (value.equals("none", ignoreCase = true)) {
          emptyList()
        } else {
          value.split(',').map { it.trim() }.filter { it.isNotEmpty() }
        }
        Settings.setExcluded(this, packages)
      }
      Log.i(TAG, "settings saved from extras: bootstrap/relays/slots/mode/country/apps")
    }
    setContent {
      UiLanguageProvider {
        MagnetGateTheme {
          Surface(
            modifier = Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background,
          ) {
            AppRoot(
              autotest = autotest,
              vpn = extras?.getStringExtra("vpn") == "true",
              coreless = extras?.getStringExtra("coreless") == "true",
              bootstrapExtra = extras?.getStringExtra("bootstrap").orEmpty(),
              relaysExtra = extras?.getStringExtra("relays").orEmpty(),
              checkUrlExtra = extras?.getStringExtra("checkurl").orEmpty(),
              modeExtra = extras?.getStringExtra("mode").orEmpty(),
              engineLogExtra = extras?.getStringExtra("enginelog").orEmpty(),
              screenExtra = extras?.getStringExtra("screen").orEmpty(),
              breakSlotExtra = extras?.getStringExtra("breakslot").orEmpty(),
            )
          }
        }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // the app is usually already running when someone wants its state, so the dump hook has to work here
    // and not only in onCreate
    if (intent.getStringExtra("dump") == "true") dumpStatus()
    if (intent.getStringExtra("stop") == "true" && fromShell()) stopTunnel()
    if (intent.getStringExtra("kill") == "true" && fromShell()) killProcess()
    if (intent.getStringExtra("report") == "true" && fromShell()) {
      Reports.write(this, IllegalStateException("synthetic report requested over adb"), "hook")
      Log.i(TAG, "report hook: enabled=${Reports.enabled(this)} waiting=${Reports.pending(this).size}")
    }
  }

  /**
   * Whether this launch may drive the tunnel: a debuggable build, started from a shell.
   *
   * The build being debuggable was the whole test until this application was about to be handed to
   * other people. The launcher activity is exported, so `stop`, `kill` and the acceptance hooks were
   * reachable by anything on the phone that can send an intent - which on a stranger's phone means any
   * application could switch their VPN off. The package cannot simply stop being debuggable, because
   * an update only installs over a build signed with the same key, and everyone in this group has to
   * stay on one key for updates to work at all; the diagnostics the work depends on need it too.
   *
   * So the second half of the gate is who sent the intent. `adb` starts activities as the shell, and
   * nothing else on a phone runs as that uid. Below API 34 the caller cannot be identified and the
   * hooks stay where they were, behind the debuggable flag alone - an older phone in this group is a
   * phone whose owner is trusted with an acceptance build anyway.
   */
  private fun fromShell(): Boolean {
    if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) == 0) return false
    // `launchedFromUid` is the answer this wants and it is not available here: it returns -1 on this
    // ROM, and `launchedFromPackage` returns null with it. What the system does fill in is the
    // referrer, and for `am start` that is `android-app://com.android.shell`.
    //
    // A referrer can be claimed rather than earned: an application may put EXTRA_REFERRER in the
    // intent it sends, and getReferrer() prefers it over the caller the system knows. So a launch that
    // carries one is not trusted at all - adb does not set it, and an application that wants to look
    // like adb has to.
    val claimed = intent?.hasExtra(Intent.EXTRA_REFERRER) == true ||
      intent?.hasExtra(Intent.EXTRA_REFERRER_NAME) == true
    val shell = runCatching { referrer }.getOrNull()?.host == "com.android.shell"
    val allowed = shell && !claimed
    // Named in the log either way: a hook that silently does nothing is the failure this project keeps
    // meeting, and one that silently works for the wrong caller is worse.
    Log.i(TAG, "launch hook: referrer=${runCatching { referrer }.getOrNull()} claimed=$claimed -> " +
      if (allowed) "accepted" else "refused")
    return allowed
  }



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
    // The screen goes first, and the death is delayed behind it. A process that dies while one of its
    // activities is in the foreground is put back by the system to restore that activity - with the
    // launch extras it had, which on an acceptance run are `autotest vpn`, so the tunnel returns in
    // under a second and the run "passes" without anything of ours having run. Measured on 18.09: the
    // process died at 14:20:07.464 and its replacement asked for a VPN at 14:20:08.075.
    //
    // That is not the death this has to survive. The owner's app is in the background with no activity
    // at all, the service is what carries the tunnel, and the system has nothing to restore.
    finishAndRemoveTask()
    android.os.Handler(mainLooper).postDelayed(
      { android.os.Process.killProcess(android.os.Process.myPid()) },
      KILL_DELAY_MS,
    )
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
      append(
        if (health == null) {
          "check=none"
        } else {
          "check=${if (health.ok) "ok" else "failed"} took=${health.tookMs}ms at=${health.atMs}" +
            (health.legs?.let { " legs=$it" } ?: "") + " detail=${health.detail}"
        },
      )
      if (Health.engineError.isNotEmpty()) append(" engineError=${Health.engineError}")
    }
    runCatching { File(filesDir, "health.txt").writeText(line) }
    Log.i(TAG, "status dumped ($line)")
  }
}
