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
