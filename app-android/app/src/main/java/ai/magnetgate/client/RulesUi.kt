package ai.magnetgate.client

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.graphics.drawable.toBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private data class AppEntry(val packageName: String, val label: String)

@Composable
fun RulesScreen(draft: RoutingDraft, saved: RoutingDraft, pending: Boolean, vpnUp: Boolean, busy: Boolean,
  notice: String, onChange: (RoutingDraft) -> Unit, onSave: () -> Unit, onReconnect: () -> Unit,
) {
  val ui = LocalUiStrings.current
  val context = LocalContext.current
  var apps by remember { mutableStateOf<List<AppEntry>?>(null) }
  var loadError by remember { mutableStateOf(false) }
  var search by rememberSaveable { mutableStateOf("") }
  var selectedOnly by rememberSaveable { mutableStateOf(false) }
  var domainsOpen by rememberSaveable { mutableStateOf(false) }
  LaunchedEffect(Unit) {
    val result = withContext(Dispatchers.IO) { runCatching { launcherApps(context) } }
    loadError = result.isFailure
    apps = result.getOrDefault(emptyList())
  }
  val installed = apps.orEmpty()
  val entries = installed + draft.packages.filter { pkg -> installed.none { it.packageName == pkg } }
    .map { AppEntry(it, it) }
  val visible = entries.filter { (!selectedOnly || it.packageName in draft.packages) &&
    (it.label.contains(search, true) || it.packageName.contains(search, true)) }
  val dirty = draft != saved
  Column(Modifier.fillMaxSize().imePadding()) {
    LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      item {
        Text(ui.text(R.string.traffic_rules), style = MaterialTheme.typography.headlineSmall)
        Text(ui.text(R.string.traffic_rules_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      item {
        Choice(ui.text(R.string.mode_full), ui.text(R.string.mode_full_hint), draft.mode == Settings.Mode.FULL) { onChange(draft.copy(mode = Settings.Mode.FULL)) }
        Choice(ui.text(R.string.mode_split), ui.text(R.string.mode_split_hint), draft.mode == Settings.Mode.SPLIT) { onChange(draft.copy(mode = Settings.Mode.SPLIT)) }
      }
      item {
        ActionRow(if (draft.mode == Settings.Mode.FULL) ui.text(R.string.excluded_websites) else ui.text(R.string.tunnel_websites),
          ui.text(R.string.domain_count, if (draft.mode == Settings.Mode.FULL) draft.direct.size else draft.tunnel.size)) { domainsOpen = true }
        HorizontalDivider()
      }
      item {
        SectionLabel(ui.text(R.string.applications))
        Choice(ui.text(R.string.apps_except), ui.text(R.string.apps_except_hint), draft.apps == Settings.Apps.EXCEPT) { onChange(draft.copy(apps = Settings.Apps.EXCEPT)) }
        Choice(ui.text(R.string.apps_only), ui.text(R.string.apps_only_hint), draft.apps == Settings.Apps.ONLY) { onChange(draft.copy(apps = Settings.Apps.ONLY)) }
      }
      item {
        Text(if (draft.mode == Settings.Mode.SPLIT) ui.text(R.string.split_scope_hint)
          else ui.text(R.string.full_scope_hint), style = MaterialTheme.typography.bodySmall)
        if (draft.apps == Settings.Apps.ONLY && draft.packages.isEmpty()) InfoNotice(ui.text(R.string.empty_only_hint))
      }
      item {
        OutlinedTextField(value = search, onValueChange = { search = it }, modifier = Modifier.fillMaxWidth(),
          label = { Text(ui.text(R.string.search_apps)) }, leadingIcon = { UiIcon(R.drawable.ic_search) }, singleLine = true)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          Text(ui.text(R.string.selected_count, draft.packages.size), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
          FilterChip(selectedOnly, onClick = { selectedOnly = !selectedOnly }, label = { Text(ui.text(R.string.selected_apps)) })
        }
      }
      if (apps == null) item { Text(ui.text(R.string.loading_apps), style = MaterialTheme.typography.bodySmall) }
      else if (loadError) item { InfoNotice(ui.text(R.string.apps_load_failed), true) }
      else if (visible.isEmpty()) item { Text(if (search.isNotBlank()) ui.text(R.string.search_no_results) else ui.text(R.string.apps_empty)) }
      items(visible, key = { it.packageName }) { app ->
        val checked = app.packageName in draft.packages
        Row(Modifier.fillMaxWidth().toggleable(checked, role = Role.Checkbox, onValueChange = { value ->
          onChange(draft.copy(packages = if (value) draft.packages + app.packageName else draft.packages - app.packageName))
        }).heightIn(min = 64.dp).padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
          ApplicationIcon(context, app)
          Column(Modifier.weight(1f)) {
            Text(app.label, style = MaterialTheme.typography.bodyLarge)
            Text(app.packageName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
          }
          Checkbox(checked, onCheckedChange = null)
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
      }
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      if (notice.isNotBlank()) InfoNotice(notice)
      Text(when { dirty -> ui.text(R.string.rules_unsaved); pending -> ui.text(R.string.rules_pending); vpnUp -> ui.text(R.string.rules_applied); else -> ui.text(R.string.rules_next_connection) }, style = MaterialTheme.typography.bodySmall)
      BottomAction(if (dirty) ui.text(R.string.save_rules) else if (pending) ui.text(R.string.reconnect_apply) else ui.text(R.string.saved), enabled = !busy && (dirty || pending), onClick = if (dirty) onSave else onReconnect)
    }
  }
  if (domainsOpen) DomainEditor(draft, onChange, onClose = { domainsOpen = false })
}

@Composable
private fun ApplicationIcon(context: Context, app: AppEntry) {
  var bitmap by remember(app.packageName) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
  LaunchedEffect(app.packageName) {
    bitmap = withContext(Dispatchers.IO) {
      runCatching { context.packageManager.getApplicationIcon(app.packageName).toBitmap(72, 72).asImageBitmap() }.getOrNull()
    }
  }
  if (bitmap != null) Image(bitmap!!, contentDescription = null, modifier = Modifier.size(36.dp))
  else Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
    Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) { Text(app.label.take(1)) }
  }
}

private fun launcherApps(context: Context): List<AppEntry> {
  val manager = context.packageManager
  return manager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
    .mapNotNull { it.activityInfo?.applicationInfo }.distinctBy { it.packageName }
    .filter { it.packageName != context.packageName }
    .map { AppEntry(it.packageName, runCatching { manager.getApplicationLabel(it).toString() }.getOrDefault(it.packageName)) }
    .sortedBy { it.label.lowercase() }
}

@Composable
fun Choice(title: String, detail: String, selected: Boolean, onClick: () -> Unit) {
  Row(Modifier.fillMaxWidth().clickable(role = Role.RadioButton, onClick = onClick).heightIn(min = 64.dp).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
    RadioButton(selected, onClick = null)
    Column(Modifier.weight(1f)) {
      Text(title, style = MaterialTheme.typography.titleSmall)
      Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}

@Composable
private fun DomainEditor(draft: RoutingDraft, onChange: (RoutingDraft) -> Unit, onClose: () -> Unit) {
  val ui = LocalUiStrings.current
  var input by rememberSaveable { mutableStateOf("") }
  var error by remember { mutableIntStateOf(0) }
  var removed by remember { mutableStateOf<String?>(null) }
  val domains = if (draft.mode == Settings.Mode.FULL) draft.direct else draft.tunnel
  fun update(next: List<String>) { onChange(if (draft.mode == Settings.Mode.FULL) draft.copy(direct = next) else draft.copy(tunnel = next)) }
  AlertDialog(onDismissRequest = onClose,
    title = { Text(if (draft.mode == Settings.Mode.FULL) ui.text(R.string.direct_websites) else ui.text(R.string.tunnel_websites)) },
    text = {
      Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(input, { input = it; error = 0 }, label = { Text(ui.text(R.string.domain)) }, placeholder = { Text("example.org") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), singleLine = true, isError = error != 0, modifier = Modifier.fillMaxWidth(), supportingText = { Text(ui.text(if (error == 0) R.string.domain_hint else error)) })
        TextButton(onClick = {
          val normalized = normalizeDomain(input)
          when { normalized == null -> error = R.string.domain_invalid
            normalized in domains -> error = R.string.domain_duplicate
            domains.size >= 10000 -> error = R.string.domain_limit
            else -> { update(domains + normalized); input = ""; error = 0 }
          }
        }) { Text(ui.text(R.string.add)) }
        LazyColumn(Modifier.heightIn(max = 240.dp)) {
          if (domains.isEmpty()) item { Text(ui.text(R.string.list_empty), style = MaterialTheme.typography.bodySmall) }
          items(domains, key = { it }) { domain ->
            Row(verticalAlignment = Alignment.CenterVertically) {
              Text(domain, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
              IconButton(onClick = { update(domains - domain); removed = domain }) { UiIcon(R.drawable.ic_delete, ui.text(R.string.delete_domain, domain)) }
            }
          }
        }
        removed?.let { domain -> TextButton(onClick = { update((domains + domain).distinct()); removed = null }) { Text(ui.text(R.string.undo_delete)) } }
        Text(ui.text(R.string.save_after_close), style = MaterialTheme.typography.bodySmall)
      }
    }, confirmButton = { TextButton(onClick = onClose) { Text(ui.text(R.string.done)) } },
  )
}
