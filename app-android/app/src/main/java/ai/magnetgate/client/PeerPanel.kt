package ai.magnetgate.client

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

@Composable
fun PeerPanel(enabled: Boolean, country: String, status: JSONObject, error: String, editable: Boolean, provisioned: Boolean, onChoice: (Boolean, String) -> Unit) {
  val ui = LocalUiStrings.current
  var choosing by remember { mutableStateOf(false) }
  var details by remember { mutableStateOf(false) }
  var search by remember { mutableStateOf("") }
  val countries = status.optJSONArray("countries") ?: JSONArray()
  val rows = (0 until countries.length()).mapNotNull { countries.optJSONObject(it) }
  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    val choices: @Composable (Modifier) -> Unit = { modifier ->
      FilterChip(selected = !enabled, onClick = { onChoice(false, country) }, enabled = editable,
        modifier = modifier, label = { Text(ui.text(R.string.peer_servers)) })
      FilterChip(selected = enabled, onClick = { onChoice(true, country) }, enabled = editable,
        modifier = modifier, label = { Text(ui.text(R.string.peer_users)) })
    }
    if (LocalDensity.current.fontScale > 1.3f) {
      Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
        choices(Modifier.fillMaxWidth())
      }
    } else Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
      choices(Modifier.weight(1f))
    }
    if (enabled) {
      Surface(onClick = { search = ""; choosing = true }, shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
          UiIcon(R.drawable.ic_globe)
          Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(ui.text(R.string.peer_location), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(ui.countryName(country), style = MaterialTheme.typography.titleMedium)
            val actual = status.optString("guestCountry")
            if (country.isBlank() && status.optBoolean("guestConnected") && actual.isNotBlank())
              Text(ui.text(R.string.peer_connected_country, ui.countryName(actual)), style = MaterialTheme.typography.bodySmall)
          }
          UiIcon(R.drawable.ic_next)
        }
      }
      val hint = when {
        !provisioned -> ui.text(R.string.peer_unconfigured)
        !status.optBoolean("connected") -> ui.text(R.string.peer_directory_wait)
        status.optBoolean("guestConnected") -> ""
        country.isNotBlank() && rows.none { it.optString("cc") == country } -> ui.text(R.string.peer_country_missing)
        rows.isEmpty() -> ui.text(R.string.peer_empty)
        else -> ""
      }
      if (hint.isNotEmpty()) Text(hint, style = MaterialTheme.typography.bodySmall)
      if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
      TextButton(onClick = { details = true }, contentPadding = PaddingValues(0.dp)) { Text(ui.text(R.string.peer_details)) }
    }
  }
  if (enabled && choosing) AlertDialog(
    onDismissRequest = { choosing = false }, title = { Text(ui.text(R.string.peer_location)) },
    confirmButton = { TextButton(onClick = { choosing = false }) { Text(ui.text(R.string.peer_done)) } },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!editable) Text(ui.text(R.string.peer_change_after_disconnect), style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(search, { search = it }, label = { Text(ui.text(R.string.peer_search)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        LazyColumn(Modifier.heightIn(max = 320.dp).selectableGroup()) {
          item {
            PeerCountryRow(ui.text(R.string.automatic), "", country.isBlank(), editable) { onChoice(true, ""); choosing = false }
          }
          if (country.isNotBlank() && rows.none { it.optString("cc") == country }) item {
            PeerCountryRow(ui.countryName(country), ui.text(R.string.peer_empty), true, false) {}
          }
          items(rows.filter { row ->
            val cc = row.optString("cc")
            search.isBlank() || cc.contains(search, true) || ui.countryName(cc).contains(search, true)
          }, key = { it.optString("cc") }) { row ->
            val cc = row.optString("cc")
            PeerCountryRow(ui.countryName(cc), ui.text(R.string.peer_available, row.optInt("nodes")), country == cc, editable) {
              onChoice(true, cc); choosing = false
            }
          }
          if (rows.isEmpty()) item { Text(ui.text(R.string.peer_empty), Modifier.padding(vertical = 12.dp)) }
        }
      }
    },
  )
  if (enabled && details) AlertDialog(onDismissRequest = { details = false },
    title = { Text(ui.text(R.string.peer_details)) },
    text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text(ui.text(R.string.peer_tcp_hint)); Text(ui.text(R.string.peer_android_guest))
    } },
    confirmButton = { TextButton(onClick = { details = false }) { Text(ui.text(R.string.peer_done)) } },
  )
}

@Composable
private fun PeerCountryRow(title: String, detail: String, selected: Boolean, enabled: Boolean, onSelect: () -> Unit) {
  Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(selected, enabled, Role.RadioButton, onSelect),
    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    RadioButton(selected, onClick = null, enabled = enabled)
    Column(Modifier.weight(1f)) {
      Text(title, style = MaterialTheme.typography.bodyLarge)
      if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}
