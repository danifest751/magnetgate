package ai.magnetgate.client

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import kotlinx.coroutines.launch

@Composable
fun PeerSharingPanel(status: JSONObject, provisioned: Boolean) {
  val ui = LocalUiStrings.current
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val policy = status.optJSONObject("policy") ?: JSONObject()
    .put("enabled", false).put("automatic", true).put("maxMbps", 5).put("maxGuests", 2)
    .put("dailyBytes", 1L shl 30).put("monthlyBytes", 20L shl 30)
  val checked = status.optBoolean("sharingRequested")
  val available = provisioned && status.optBoolean("canShare")
  var limits by remember { mutableStateOf(false) }
  var automatic by remember { mutableStateOf(true) }
  var speed by remember { mutableFloatStateOf(5f) }
  var guests by remember { mutableIntStateOf(2) }
  var failed by remember { mutableStateOf(false) }
  fun apply(next: JSONObject) {
    failed = runCatching { PeerSharingService.apply(context, next) }.isFailure
  }
  Column {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp)
      .toggleable(checked, enabled = available || checked, role = Role.Checkbox) {
        apply(JSONObject(policy.toString()).put("enabled", it))
      }, verticalAlignment = Alignment.CenterVertically) {
      Checkbox(checked, onCheckedChange = null, enabled = available || checked)
      Text(ui.text(R.string.peer_share_toggle), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
    }
    val message = when {
      failed || status.optBoolean("sharingError") -> R.string.peer_share_failed
      !provisioned -> R.string.peer_unconfigured
      !available -> R.string.peer_share_unprovisioned
      !checked -> R.string.peer_share_off
      status.optBoolean("sharing") -> R.string.peer_share_ready
      else -> R.string.peer_share_paused
    }
    Text(ui.text(message), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (available) TextButton(onClick = {
      automatic = policy.optBoolean("automatic", true)
      speed = policy.optDouble("maxMbps", 5.0).toFloat()
      guests = policy.optInt("maxGuests", 2)
      limits = true
    }, contentPadding = PaddingValues(0.dp)) { Text(ui.text(R.string.peer_share_limits)) }
  }
  if (limits) AlertDialog(onDismissRequest = { limits = false },
    title = { Text(ui.text(R.string.peer_share_limits)) },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth().toggleable(automatic, role = Role.Checkbox) { automatic = it }, verticalAlignment = Alignment.CenterVertically) {
          Checkbox(automatic, onCheckedChange = null)
          Text(ui.text(R.string.peer_share_auto), Modifier.weight(1f))
        }
        Text(ui.text(R.string.peer_share_speed, if (automatic) "5" else String.format(java.util.Locale.ROOT, "%.1f", speed)))
        Slider(speed, { speed = it }, enabled = !automatic, valueRange = 0.1f..5f)
        Text(ui.text(R.string.peer_share_guests))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          for (count in 1..2) FilterChip(guests == count, { guests = count }, label = { Text(count.toString()) })
        }
        Text(ui.text(R.string.peer_share_quota, status.optLong("sharedDaily") / (1L shl 20), status.optLong("sharedMonthly") / (1L shl 20)), style = MaterialTheme.typography.bodySmall)
      }
    },
    dismissButton = { TextButton(onClick = { limits = false }) { Text(ui.text(R.string.peer_done)) } },
    confirmButton = { TextButton(onClick = {
      val next = JSONObject(policy.toString()).put("enabled", checked)
        .put("automatic", automatic).put("maxMbps", if (automatic) 5.0 else speed.toDouble()).put("maxGuests", guests)
      // Disabled edits persist through the same native policy validation, without starting a service.
      if (checked) apply(next) else {
        scope.launch {
          failed = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { runCatching { PeerRuntime.setPolicy(next) }.isFailure }
        }
      }
      limits = false
    }) { Text(ui.text(R.string.peer_share_save)) } },
  )
}
