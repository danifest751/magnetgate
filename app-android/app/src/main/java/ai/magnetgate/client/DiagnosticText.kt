package ai.magnetgate.client

private val ipv4InDiagnostic = Regex("\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b")
private val ipv6InDiagnostic = Regex("(?:[a-f\\d]{0,4}:){2,}[a-f\\d:.]*", RegexOption.IGNORE_CASE)

/** Hides addresses in text shown in diagnostics; [hidden] is the placeholder in the UI language. */
internal fun diagnosticText(value: String, hidden: String = "[address hidden]"): String =
  ipv6InDiagnostic.replace(ipv4InDiagnostic.replace(value, hidden)) { match ->
    if (match.value.contains("::") || match.value.count { it == ':' } >= 3) hidden else match.value
  }
