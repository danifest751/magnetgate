package ai.magnetgate.client

import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
    val autotest =
      extras?.getStringExtra("autotest") == "true" || extras?.getBooleanExtra("autotest", false) == true
    Log.i(TAG, "app started, core ${Mgbox.coreVersion()}, autotest=$autotest")

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
  }

  /**
   * Writes what the core currently reports to the app's files directory: the diagnostics screen and the
   * acceptance scripts both want it, and the core's log ring only exists in this process.
   */
  private fun dumpStatus() {
    val status = runCatching { Mgbox.coreStatus() }.getOrElse { "status failed: ${it.message}" }
    runCatching { File(filesDir, "status.txt").writeText(status) }
    Log.i(TAG, "status dumped")
  }
}
