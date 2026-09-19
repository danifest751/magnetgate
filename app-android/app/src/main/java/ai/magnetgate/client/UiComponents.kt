package ai.magnetgate.client

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

enum class Screen(val label: Int, val icon: Int) {
  CONNECT(R.string.nav_connection, R.drawable.ic_power),
  RULES(R.string.nav_rules, R.drawable.ic_rules),
  SETTINGS(R.string.nav_settings, R.drawable.ic_settings),
  DIAGNOSTICS(R.string.nav_diagnostics, R.drawable.ic_activity),
  ACCESS(R.string.nav_access, R.drawable.ic_magnet),
  COUNTRIES(R.string.nav_countries, R.drawable.ic_globe),
}

@Composable
fun UiIcon(id: Int, description: String? = null, size: androidx.compose.ui.unit.Dp = 22.dp) {
  Icon(painterResource(id), contentDescription = description, modifier = Modifier.size(size))
}

@Composable
fun AppHeader(screen: Screen, onBack: () -> Unit) {
  val ui = LocalUiStrings.current
  Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
    if (screen in listOf(Screen.CONNECT, Screen.RULES, Screen.SETTINGS)) {
      UiIcon(R.drawable.ic_magnet, size = 27.dp)
      Spacer(Modifier.width(9.dp))
      Text("MagnetGate", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
      Spacer(Modifier.width(8.dp))
      LanguageSwitch()
    } else {
      Text(ui.text(screen.label), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
      IconButton(onClick = onBack) { UiIcon(R.drawable.ic_back, ui.text(R.string.back)) }
    }
  }
}

@Composable
fun LanguageSwitch() {
  val ui = LocalUiStrings.current
  val selection = LocalUiLanguage.current
  Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
    Row(Modifier.selectableGroup().semantics { contentDescription = ui.text(R.string.language) }) {
      UiLanguage.entries.forEach { language ->
        val selected = selection.language == language
        val label = ui.text(if (language == UiLanguage.RU) R.string.language_ru else R.string.language_en)
        Box(Modifier
          .selectable(selected, role = Role.RadioButton, onClick = { selection.select(language) })
          .semantics { contentDescription = label }
          .background(if (selected) MaterialTheme.colorScheme.primaryContainer else androidx.compose.ui.graphics.Color.Transparent)
          .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
          .padding(horizontal = 8.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
          Text(language.name, style = MaterialTheme.typography.labelLarge.copy(fontSize = 12.sp, letterSpacing = 0.sp),
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant)
        }
      }
    }
  }
}

@Composable
fun AppNavigation(screen: Screen, onSelect: (Screen) -> Unit) {
  val ui = LocalUiStrings.current
  val selected = when (screen) {
    Screen.COUNTRIES, Screen.DIAGNOSTICS -> Screen.CONNECT
    Screen.ACCESS -> Screen.SETTINGS
    else -> screen
  }
  NavigationBar(containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp, windowInsets = WindowInsets(0, 0, 0, 0)) {
    listOf(Screen.CONNECT, Screen.RULES, Screen.SETTINGS).forEach { item ->
      NavigationBarItem(
        selected = item == selected, onClick = { onSelect(item) },
        icon = { UiIcon(item.icon) },
        label = { Text(if (item == Screen.CONNECT) ui.text(R.string.nav_home) else ui.text(item.label), style = MaterialTheme.typography.labelSmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.SansSerif, fontSize = 12.sp, letterSpacing = 0.sp)) },
        colors = NavigationBarItemDefaults.colors(
          indicatorColor = MaterialTheme.colorScheme.surfaceVariant,
          selectedIconColor = MaterialTheme.colorScheme.onSurface,
          selectedTextColor = MaterialTheme.colorScheme.onSurface,
        ),
      )
    }
  }
}

@Composable
fun StatusPanel(presentation: ConnectionPresentation) {
  val state = LocalStateColors.current
  val (ink, ground) = when (presentation.tone) {
    ConnectionTone.OK -> state.ok to state.okSurface
    ConnectionTone.WARN -> state.warn to state.warnSurface
    ConnectionTone.BAD -> state.bad to state.badSurface
    ConnectionTone.OFF -> MaterialTheme.colorScheme.onSurfaceVariant to MaterialTheme.colorScheme.surfaceVariant
  }
  Surface(color = ground, shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth()) {
    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Icon(painterResource(if (presentation.tone == ConnectionTone.OK) R.drawable.ic_check else if (presentation.tone == ConnectionTone.OFF) R.drawable.ic_power else R.drawable.ic_alert), null, tint = ink, modifier = Modifier.size(24.dp))
      Text(presentation.title, color = ink, style = MaterialTheme.typography.headlineSmall)
      Text(presentation.detail, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodySmall)
    }
  }
}

@Composable
fun InfoNotice(text: String, error: Boolean = false) {
  val colors = LocalStateColors.current
  Surface(color = if (error) colors.badSurface else colors.warnSurface, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }) {
    Text(text, modifier = Modifier.padding(12.dp), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodySmall)
  }
}

@Composable
fun ActionRow(title: String, detail: String = "", icon: Int = R.drawable.ic_next, onClick: () -> Unit) {
  Row(Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 56.dp).padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
      Text(title, style = MaterialTheme.typography.bodyLarge)
      if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    UiIcon(icon)
  }
}

@Composable
fun SwitchRow(title: String, detail: String, checked: Boolean, onChange: (Boolean) -> Unit) {
  Row(
    Modifier.fillMaxWidth().toggleable(value = checked, role = Role.Switch, onValueChange = onChange)
      .heightIn(min = 56.dp).padding(vertical = 10.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
      Text(title, style = MaterialTheme.typography.bodyLarge)
      if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    // Состояние озвучивает строка целиком: у самого переключателя обработчика нет, иначе TalkBack
    // прочитает элемент дважды.
    Switch(checked = checked, onCheckedChange = null)
  }
}

@Composable
fun SectionLabel(text: String) {
  Text(text.uppercase(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
}

@Composable
fun ValueRow(label: String, value: String) {
  Column(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
    Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(value, style = MaterialTheme.typography.bodyMedium, fontFamily = Mono)
  }
}

@Composable
fun BottomAction(text: String, enabled: Boolean = true, secondary: Boolean = false, onClick: () -> Unit) {
  val modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)
  if (secondary) OutlinedButton(onClick, modifier, enabled = enabled, shape = RoundedCornerShape(12.dp)) {
    Text(text, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(vertical = 4.dp))
  } else Button(onClick, modifier, enabled = enabled, shape = RoundedCornerShape(12.dp)) {
    Text(text, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(vertical = 4.dp))
  }
}

@Composable
fun ConnectScreen(
  status: CoreStatus, vpnUp: Boolean, starting: Boolean, busy: Boolean, keySet: Boolean,
  check: Health.Check?, presentation: ConnectionPresentation, country: String, routing: RoutingDraft,
  pending: Boolean, notice: String, onConnect: () -> Unit, onDisconnect: () -> Unit,
  onOpen: (Screen) -> Unit, onReconnect: () -> Unit,
  // The update worth offering, already compared with what is installed (Updates.offered); null when
  // this phone is current, which is the usual case and shows nothing at all.
  update: UpdateRow? = null, installedBuild: Long = 0, updateState: String = "", onUpdate: () -> Unit = {},
  updateReady: Boolean = false,
) {
  val ui = LocalUiStrings.current
  Column(Modifier.fillMaxSize()) {
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
      StatusPanel(presentation)
      if (notice.isNotBlank()) InfoNotice(notice)
      update?.let {
        UpdateCard(it, installedBuild, updateState.ifBlank {
          if (updateReady) ui.text(R.string.update_install_now) else ""
        }, busy, onUpdate)
      }
      Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surface, border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), onClick = { onOpen(Screen.COUNTRIES) }) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
          Surface(shape = RoundedCornerShape(9.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
            Box(Modifier.size(42.dp), contentAlignment = Alignment.Center) { if (country.isBlank()) UiIcon(R.drawable.ic_globe) else Text(country, fontFamily = Mono) }
          }
          Column(Modifier.weight(1f)) {
            Text(ui.text(R.string.preferred_country), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(ui.countryName(country), style = MaterialTheme.typography.titleMedium)
          }
          UiIcon(R.drawable.ic_next)
        }
      }
      if (vpnUp && country.isNotBlank() && status.nodes.none { it.country.equals(country, true) })
        InfoNotice(ui.text(R.string.country_unavailable, ui.countryName(country)))
      Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
          Text(ui.text(R.string.tunnel_latency), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          Text(ui.text(R.string.session_received), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
          Text(check?.takeIf { vpnUp && it.ok }?.legs?.pingMs?.let { ui.text(R.string.milliseconds, it) } ?: "—", Modifier.weight(1f), style = MaterialTheme.typography.headlineSmall, fontFamily = Mono)
          Text(if (vpnUp) ui.bytes(status.received) else "—", Modifier.weight(1f), style = MaterialTheme.typography.headlineSmall, fontFamily = Mono)
        }
      }
      HorizontalDivider()
      Column {
        ActionRow(ui.text(R.string.routing), routing.summary(ui)) { onOpen(Screen.RULES) }
        ActionRow(ui.text(R.string.diagnostics_action), icon = R.drawable.ic_activity) { onOpen(Screen.DIAGNOSTICS) }
      }
      if (status.relaysConfiguredButSilent && vpnUp) InfoNotice(ui.text(R.string.relays_silent))
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      if (pending) {
        InfoNotice(ui.text(R.string.pending_settings))
        BottomAction(ui.text(R.string.reconnect_apply), enabled = !busy && !starting, onClick = onReconnect)
      }
      BottomAction(
        text = when { starting -> ui.text(R.string.connecting_action); !keySet && !vpnUp -> ui.text(R.string.add_access); vpnUp -> ui.text(R.string.disconnect); else -> ui.text(R.string.connect) },
        enabled = !busy && !starting, secondary = vpnUp,
        onClick = { if (vpnUp) onDisconnect() else if (!keySet) onOpen(Screen.ACCESS) else onConnect() },
      )
    }
  }
}

/**
 * The one place this application ever offers to install code.
 *
 * It says which build is offered and what the phone is running, because "an update is available" with
 * no numbers is exactly the message a person cannot check. Nothing happens until it is tapped: the
 * package is some 85 MB and this client is often on a mobile network.
 */
@Composable
fun UpdateCard(update: UpdateRow, installed: Long, state: String, busy: Boolean, onAct: () -> Unit) {
  val ui = LocalUiStrings.current
  Surface(
    shape = RoundedCornerShape(18.dp),
    color = MaterialTheme.colorScheme.surface,
    border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    onClick = { if (!busy) onAct() },
  ) {
    Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      Surface(shape = RoundedCornerShape(9.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
        Box(Modifier.size(42.dp), contentAlignment = Alignment.Center) { UiIcon(R.drawable.ic_activity) }
      }
      Column(Modifier.weight(1f)) {
        Text(ui.text(R.string.update_available), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("${update.versionCode} · ${update.versionName}", style = MaterialTheme.typography.titleMedium, fontFamily = Mono)
        Text(
          state.ifBlank { ui.text(R.string.update_from_build, installed) },
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
      UiIcon(R.drawable.ic_next)
    }
  }
}

@Composable
fun CountriesScreen(status: CoreStatus, selected: String, notice: String, onSelect: (String) -> Unit, onBack: () -> Unit) {
  val ui = LocalUiStrings.current
  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
    Text(ui.text(R.string.new_connections), style = MaterialTheme.typography.headlineSmall)
    if (notice.isNotBlank()) InfoNotice(notice, true)
    val codes = (listOf("") + status.countries.map { it.code } + listOfNotNull(selected.takeIf { it.isNotBlank() })).distinct()
    codes.forEach { code ->
      Surface(onClick = { onSelect(code) }, shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surface, border = androidx.compose.foundation.BorderStroke(1.dp, if (selected == code) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant)) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
          Column(Modifier.weight(1f)) {
            Text(ui.countryName(code), style = MaterialTheme.typography.titleMedium)
            Text(if (code.isBlank()) ui.text(R.string.any_country) else ui.text(R.string.server_count, status.nodes.count { it.country.equals(code, true) }), style = MaterialTheme.typography.bodySmall)
          }
          RadioButton(selected == code, onClick = null)
        }
      }
    }
    if (status.countries.isEmpty()) Text(ui.text(R.string.countries_empty), style = MaterialTheme.typography.bodySmall)
    InfoNotice(ui.text(R.string.country_preference_hint))
    Text(ui.text(R.string.existing_routes_hint), style = MaterialTheme.typography.bodySmall)
    BottomAction(ui.text(R.string.done), onClick = onBack)
  }
}
