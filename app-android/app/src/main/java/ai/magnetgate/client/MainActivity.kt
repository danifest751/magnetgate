package ai.magnetgate.client

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
import mobile.Mobile
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
    val bootstrap = extras?.getStringExtra("bootstrap").orEmpty()
    val relays = extras?.getStringExtra("relays").orEmpty()
    Log.i(TAG, "app started, core ${Mobile.Version}, autotest=$autotest")
    setContent {
      MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
          CoreScreen(autotest, bootstrap, relays)
        }
      }
    }
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

private fun pskFromDevice(context: android.content.Context): String {
  // The test harness drops the PSK here; the settings screen will own this properly later
  val file = File(context.filesDir, "psk.txt")
  return if (file.exists()) file.readText().trim() else ""
}

private fun joinArray(values: List<String>): JSONArray {
  val array = JSONArray()
  for (value in values) array.put(value)
  return array
}

private fun configJson(psk: String, bootstrap: List<String>, relays: List<String>): String {
  val config = JSONObject()
  config.put("psk", psk)
  // slots are numbers: the core decodes them as []int
  config.put("slots", JSONArray().put(0))
  config.put("bootstrap", joinArray(bootstrap))
  config.put("relays", joinArray(relays))
  return config.toString()
}

private fun splitList(value: String): List<String> =
  value.split(',', ' ').map { it.trim() }.filter { it.isNotEmpty() }

private suspend fun startCore(psk: String, bootstrap: List<String>, relays: List<String>): Result<Int> =
  withContext(Dispatchers.IO) {
    runCatching {
      val port = Mobile.start(configJson(psk, bootstrap, relays))
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

@Composable
private fun CoreScreen(autotest: Boolean, bootstrapExtra: String, relaysExtra: String) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()

  var psk by remember { mutableStateOf(pskFromDevice(context)) }
  var bootstrap by remember { mutableStateOf(bootstrapExtra.ifEmpty { "127.0.0.1:20001" }) }
  var relays by remember { mutableStateOf(relaysExtra) }
  var port by remember { mutableStateOf(0) }
  var status by remember { mutableStateOf("core not started") }
  var egress by remember { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }

  suspend fun refreshStatus() {
    status = runCatching { Mobile.status() }.getOrElse { "status failed: ${it.message}" }
  }

  suspend fun start() {
    busy = true
    val result = startCore(psk, splitList(bootstrap), splitList(relays))
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
    }
  }

  Column(
    modifier = Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text("MagnetGate core", style = MaterialTheme.typography.titleLarge)
    Text("core ${Mobile.Version}", style = MaterialTheme.typography.bodySmall)

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
            withContext(Dispatchers.IO) { Mobile.stop() }
            port = 0
            egress = ""
            refreshStatus()
          }
        },
        enabled = !busy,
      ) { Text("Stop") }
    }

    if (egress.isNotEmpty()) Text(egress, style = MaterialTheme.typography.bodyLarge)

    Text(
      statusLines(status).joinToString("\n"),
      style = MaterialTheme.typography.bodySmall,
      fontFamily = FontFamily.Monospace,
    )
  }
}
