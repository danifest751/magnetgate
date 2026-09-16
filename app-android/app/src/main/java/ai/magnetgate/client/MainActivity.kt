package ai.magnetgate.client

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ai.magnetgate.core.mgbox.Mgbox
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL

private const val TAG = "magnetgate"

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val extras = intent
    val autotest =
      extras?.getStringExtra("autotest") == "true" || extras?.getBooleanExtra("autotest", false) == true
    if (extras?.getStringExtra("dump") == "true") {
      dumpStatus()
      return
    }
    Log.i(TAG, "app started, core ${Mgbox.coreVersion()}, autotest=$autotest")
    setContent {
      MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
          CoreScreen(
            autotest = autotest,
            vpn = intent?.getStringExtra("vpn") == "true",
            coreless = intent?.getStringExtra("coreless") == "true",
            bootstrapExtra = intent?.getStringExtra("bootstrap").orEmpty(),
            relaysExtra = intent?.getStringExtra("relays").orEmpty(),
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

/** One node as the core reports it, flattened for the screen. */
private fun statusLines(statusJson: String): List<String> {
  val status = runCatching { JSONObject(statusJson) }.getOrNull() ?: return listOf("status is not JSON")
  val lines = mutableListOf<String>()
  lines += "core ${status.optString("version")} running=${status.optBoolean("running")} socks=127.0.0.1:${status.optInt("socksPort")}"
  val error = status.optString("error")
  if (error.isNotEmpty()) lines += "error: $error"
  lines += "slots: ${status.optJSONArray("slots") ?: JSONArray()}"
  val exits = status.optJSONObject("snapshot")?.optJSONArray("exits") ?: JSONArray()
  for (index in 0 until exits.length()) {
    val exit = exits.getJSONObject(index)
    val planes = mutableListOf<String>()
    val dp = exit.optJSONArray("dp") ?: JSONArray()
    for (plane in 0 until dp.length()) planes += dp.getJSONObject(plane).optString("t")
    val cooling = mutableListOf<String>()
    val paused = exit.optJSONArray("cooling") ?: JSONArray()
    for (pause in 0 until paused.length()) {
      val entry = paused.getJSONObject(pause)
      cooling += "${entry.optString("t")}(${entry.optInt("fails")})"
    }
    lines += "exit ${exit.optInt("slot")} ${exit.optString("node")} planes=$planes paused=$cooling"
  }
  val logs = status.optJSONArray("logs") ?: JSONArray()
  for (log in 0 until logs.length()) lines += "  ${logs.getString(log)}"
  return lines
}

private suspend fun startCore(psk: String, bootstrap: List<String>, relays: List<String>): Result<Int> =
  withContext(Dispatchers.IO) {
    runCatching {
      val port = Mgbox.startCore(CoreConfig.json(psk, bootstrap, relays))
      Log.i(TAG, "core started, socks port $port")
      port.toInt()
    }.onFailure { Log.e(TAG, "core failed to start: ${it.message}") }
  }

/** Fetches a URL through the core's SOCKS listener: the app's own traffic through the tunnel. */
private suspend fun fetchThroughCore(port: Int, url: String): String = withContext(Dispatchers.IO) {
  val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", port))
  val connection = URL(url).openConnection(proxy) as HttpURLConnection
  connection.connectTimeout = 20_000
  connection.readTimeout = 20_000
  try {
    connection.inputStream.bufferedReader().use { it.readText().trim() }
  } finally {
    connection.disconnect()
  }
}

private fun recordAutotest(context: android.content.Context, text: String) {
  Log.i(TAG, "AUTOTEST $text")
  runCatching { File(context.filesDir, "autotest.txt").writeText(text) }
}

/** Hands the tunnel to the service, which owns the core and the engine while it runs. */
private fun startVpn(context: Context, bootstrap: String, relays: String, coreless: Boolean) {
  val intent = Intent(context, MgVpnService::class.java)
    .setAction(MgVpnService.ACTION_START)
    .putExtra("bootstrap", bootstrap)
    .putExtra("relays", relays)
    .putExtra("coreless", coreless)
  context.startForegroundService(intent)
}

private fun stopVpn(context: Context) {
  context.startService(Intent(context, MgVpnService::class.java).setAction(MgVpnService.ACTION_STOP))
}

@Composable
private fun CoreScreen(
  autotest: Boolean,
  vpn: Boolean,
  coreless: Boolean,
  bootstrapExtra: String,
  relaysExtra: String,
) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()

  var psk by remember { mutableStateOf(CoreConfig.readPsk(context)) }
  var bootstrap by remember { mutableStateOf(bootstrapExtra.ifEmpty { "127.0.0.1:20001" }) }
  var relays by remember { mutableStateOf(relaysExtra) }
  var port by remember { mutableStateOf(0) }
  var status by remember { mutableStateOf("core not started") }
  var egress by remember { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }
  var vpnRequested by remember { mutableStateOf(MgVpnService.isRunning()) }
  val vpnConsent = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    if (result.resultCode == Activity.RESULT_OK) {
      startVpn(context, bootstrap, relays, coreless)
    } else {
      vpnRequested = false
      Log.w(TAG, "the user refused the VPN consent")
    }
  }

  suspend fun refreshStatus() {
    status = runCatching { Mgbox.coreStatus() }.getOrElse { "status failed: ${it.message}" }
  }

  suspend fun start() {
    busy = true
    val result = startCore(psk, CoreConfig.splitList(bootstrap), CoreConfig.splitList(relays))
    result.onSuccess { port = it }
    refreshStatus()
    busy = false
  }

  suspend fun checkEgress() {
    if (port == 0) return
    busy = true
    egress = runCatching { "egress ${fetchThroughCore(port, "https://api.ipify.org")}" }
      .getOrElse { "egress check failed: ${it.message}" }
    busy = false
  }

  if (autotest) {
    LaunchedEffect(Unit) {
      if (coreless) {
        // diagnostic path: the engine alone, with no second Go runtime in the process
        val consent = VpnService.prepare(context)
        if (consent != null) {
          vpnConsent.launch(consent)
        } else {
          startVpn(context, bootstrap, relays, true)
          vpnRequested = true
        }
        recordAutotest(context, "coreless vpn-requested")
        return@LaunchedEffect
      }
      if (psk.isBlank()) {
        recordAutotest(context, "fail no-psk")
        return@LaunchedEffect
      }
      start()
      if (port == 0) {
        recordAutotest(context, "fail start ${status}")
        return@LaunchedEffect
      }
      // give discovery a bounded chance, then use the tunnel the core offers
      var attempts = 0
      while (attempts < 40) {
        attempts++
        val hasExit = runCatching { JSONObject(status).optJSONObject("snapshot")?.optJSONArray("exits")?.length() ?: 0 }
          .getOrDefault(0) > 0
        if (hasExit) break
        delay(1500)
        refreshStatus()
      }
      checkEgress()
      refreshStatus()
      recordAutotest(context, "port=$port $egress")
      if (vpn) {
        // the consent dialog cannot be answered by a script, so a test run pre-grants the app-op; when
        // it was not granted, prepare() returns the intent and the tunnel simply does not come up
        val consent = VpnService.prepare(context)
        if (consent != null) {
          vpnConsent.launch(consent)
          Log.w(TAG, "AUTOTEST vpn=consent-required")
        } else {
          startVpn(context, bootstrap, relays, coreless)
          vpnRequested = true
          Log.i(TAG, "AUTOTEST vpn=requested")
        }
      }
    }
  }

  Column(
    modifier = Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text("MagnetGate core", style = MaterialTheme.typography.titleLarge)
    Text("core ${Mgbox.coreVersion()}", style = MaterialTheme.typography.bodySmall)

    OutlinedTextField(
      value = psk,
      onValueChange = { psk = it },
      label = { Text("PSK") },
      singleLine = true,
      modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
      value = bootstrap,
      onValueChange = { bootstrap = it },
      label = { Text("DHT bootstrap (host:port, comma separated)") },
      singleLine = true,
      modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
      value = relays,
      onValueChange = { relays = it },
      label = { Text("Nostr relays (comma separated)") },
      singleLine = true,
      modifier = Modifier.fillMaxWidth(),
    )

    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      Button(onClick = { scope.launch { start() } }, enabled = !busy && psk.isNotBlank()) { Text("Start") }
      Button(onClick = { scope.launch { checkEgress() } }, enabled = !busy && port != 0) { Text("Check egress") }
      Button(
        onClick = {
          scope.launch {
            withContext(Dispatchers.IO) { Mgbox.stopCore() }
            port = 0
            egress = ""
            refreshStatus()
          }
        },
        enabled = !busy,
      ) { Text("Stop") }
    }

    if (egress.isNotEmpty()) Text(egress, style = MaterialTheme.typography.bodyLarge)

    Text("VPN", style = MaterialTheme.typography.titleMedium)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      Button(
        onClick = {
          // Android requires the user's consent once; VpnService.prepare returns null when it is already
          // granted, which is also the path a pre-granted app-op takes on an emulator.
          val consent = VpnService.prepare(context)
          if (consent != null) {
            vpnConsent.launch(consent)
          } else {
            startVpn(context, bootstrap, relays, coreless)
          }
          vpnRequested = true
        },
        enabled = !vpnRequested && psk.isNotBlank(),
      ) { Text("Connect VPN") }
      Button(
        onClick = {
          stopVpn(context)
          vpnRequested = false
        },
        enabled = vpnRequested,
      ) { Text("Disconnect VPN") }
    }
    Text(if (vpnRequested) "tunnel: requested (all apps except this one)" else "tunnel: off")

    Text(
      statusLines(status).joinToString("\n"),
      style = MaterialTheme.typography.bodySmall,
      fontFamily = FontFamily.Monospace,
    )
  }
}
