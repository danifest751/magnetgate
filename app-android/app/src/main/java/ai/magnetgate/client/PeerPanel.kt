package ai.magnetgate.client

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

@Composable
fun PeerPanel(enabled: Boolean, country: String, status: JSONObject, error: String, editable: Boolean, provisioned: Boolean, onChoice: (Boolean, String) -> Unit) {
  val ui = LocalUiStrings.current
  var search by remember { mutableStateOf("") }
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(ui.text(R.string.peer_source), style = MaterialTheme.typography.labelLarge)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      FilterChip(selected = !enabled, onClick = { onChoice(false, country) }, enabled = editable,
        label = { Text(ui.text(R.string.peer_servers)) })
      FilterChip(selected = enabled, onClick = { onChoice(true, country) }, enabled = editable,
        label = { Text(ui.text(R.string.peer_users)) })
    }
    if (enabled) {
      Text(ui.text(R.string.peer_tcp_hint), style = MaterialTheme.typography.bodySmall)
      OutlinedTextField(search, { search = it }, label = { Text(ui.text(R.string.peer_search)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
      val countries = status.optJSONArray("countries") ?: JSONArray()
      val rows = (0 until countries.length()).mapNotNull { countries.optJSONObject(it) }
      FilterChip(selected = country.isBlank(), onClick = { onChoice(true, "") }, enabled = editable,
        label = { Text(ui.text(R.string.automatic)) })
      rows.filter { row ->
        val cc = row.optString("cc")
        cc == country || search.isBlank() || cc.contains(search, true) || ui.countryName(cc).contains(search, true)
      }.forEach { row ->
        val cc = row.optString("cc")
        FilterChip(selected = country == cc, enabled = editable, onClick = { onChoice(true, cc) },
          label = { Text("${ui.countryName(cc)} · ${row.optInt("nodes")}") })
      }
      if (country.isNotBlank() && rows.none { it.optString("cc") == country }) {
        FilterChip(selected = true, enabled = false, onClick = {}, label = { Text(ui.countryName(country)) })
        Text(ui.text(R.string.peer_country_missing), style = MaterialTheme.typography.bodySmall)
      }
      val hint = when {
        !provisioned -> ui.text(R.string.peer_unconfigured)
        !status.optBoolean("connected") -> ui.text(R.string.peer_directory_wait)
        rows.isEmpty() -> ui.text(R.string.peer_empty)
        else -> ""
      }
      if (hint.isNotEmpty()) Text(hint, style = MaterialTheme.typography.bodySmall)
      status.optString("guestCountry").takeIf { status.optBoolean("guestConnected") }?.let {
        Text(ui.text(R.string.now_via, ui.countryName(it)), style = MaterialTheme.typography.bodySmall)
      }
      if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
      Text(ui.text(R.string.peer_android_guest), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}
