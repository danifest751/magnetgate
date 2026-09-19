package ai.magnetgate.client

import android.content.Context
import java.util.Locale

data class RoutingDraft(
  val mode: Settings.Mode,
  val apps: Settings.Apps,
  val packages: Set<String>,
  val direct: List<String>,
  val tunnel: List<String>,
) {
  companion object {
    fun read(context: Context) = RoutingDraft(
      Settings.mode(context), Settings.apps(context), Settings.excluded(context).toSet(),
      Settings.directDomains(context), Settings.tunnelDomains(context),
    )
  }

  fun summary(ui: UiStrings): String = when {
    mode == Settings.Mode.SPLIT -> ui.text(R.string.routing_split)
    packages.isNotEmpty() || direct.isNotEmpty() -> ui.text(R.string.routing_exceptions)
    else -> ui.text(R.string.routing_full)
  }
}

enum class ConnectionTone { OFF, OK, WARN, BAD }

data class ConnectionPresentation(val title: String, val detail: String, val tone: ConnectionTone)

/** Зелёный статус подтверждается только свежим измерением текущего туннеля. */
fun connectionPresentation(
  status: CoreStatus,
  vpnUp: Boolean,
  starting: Boolean,
  keySet: Boolean,
  check: Health.Check?,
  engineError: String,
  now: Long,
  ui: UiStrings,
): ConnectionPresentation = when {
  starting -> ConnectionPresentation(ui.text(R.string.state_connecting), ui.text(R.string.state_connecting_hint), ConnectionTone.WARN)
  engineError.isNotBlank() || status.error.isNotBlank() ->
    ConnectionPresentation(ui.text(R.string.state_error), ui.text(R.string.state_error_hint), ConnectionTone.BAD)
  !vpnUp && !keySet -> ConnectionPresentation(ui.text(R.string.state_no_key), ui.text(R.string.state_no_key_hint), ConnectionTone.OFF)
  !vpnUp -> ConnectionPresentation(ui.text(R.string.connection_off), ui.text(R.string.connection_off_hint), ConnectionTone.OFF)
  !status.running -> ConnectionPresentation(ui.text(R.string.state_no_core), ui.text(R.string.state_no_core_hint), ConnectionTone.BAD)
  check == null -> ConnectionPresentation(ui.text(R.string.state_checking), ui.text(R.string.state_checking_hint), ConnectionTone.WARN)
  now - check.atMs > 150_000 -> ConnectionPresentation(ui.text(R.string.state_stale), ui.text(R.string.last_measurement, ui.clockOf(check.atMs)), ConnectionTone.WARN)
  !check.ok -> ConnectionPresentation(ui.text(R.string.state_failed), ui.text(R.string.state_failed_hint), ConnectionTone.BAD)
  status.nodes.isEmpty() -> ConnectionPresentation(ui.text(R.string.state_discovery), ui.text(R.string.state_discovery_hint), ConnectionTone.WARN)
  check.slow -> ConnectionPresentation(ui.text(R.string.state_slow), ui.text(R.string.slow_measurement, ui.durationOf(check.tookMs), ui.clockOf(check.atMs)), ConnectionTone.WARN)
  else -> ConnectionPresentation(ui.text(R.string.state_ok), ui.text(R.string.fresh_measurement, ui.clockOf(check.atMs), (now - check.atMs).coerceAtLeast(0) / 1000), ConnectionTone.OK)
}

fun UiStrings.countryName(code: String): String = if (code.isBlank()) text(R.string.automatic) else
  Locale("", code).getDisplayCountry(locale).ifBlank { code }

fun UiStrings.clockOf(atMs: Long): String = java.text.SimpleDateFormat("HH:mm:ss", locale).format(java.util.Date(atMs))

fun UiStrings.durationOf(ms: Long): String = if (ms < 1000) text(R.string.milliseconds, ms) else text(R.string.seconds, ms / 1000.0)

fun UiStrings.bytes(value: Long): String {
  if (value < 1024) return text(R.string.bytes_count, value)
  val units = listOf(R.string.unit_kb, R.string.unit_mb, R.string.unit_gb, R.string.unit_tb)
  var scaled = value.toDouble() / 1024
  var unit = 0
  while (scaled >= 1024 && unit < units.lastIndex) { scaled /= 1024; unit++ }
  return String.format(locale, "%.1f %s", scaled, text(units[unit]))
}

/** В редакторе ошибки видны до сохранения; существующие списки не переинтерпретируются. */
fun normalizeDomain(input: String): String? {
  val domain = input.trim().lowercase(Locale.ROOT).removePrefix("*.").removeSuffix(".")
  if (domain.isEmpty() || domain.length > 253) return null
  return domain.takeIf { it.split('.').all { label ->
    label.length in 1..63 && Regex("[a-z0-9](?:[a-z0-9-]*[a-z0-9])?").matches(label)
  } }
}
