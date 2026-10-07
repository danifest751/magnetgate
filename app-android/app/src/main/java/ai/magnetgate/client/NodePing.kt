package ai.magnetgate.client

import java.util.concurrent.TimeUnit
import kotlin.math.roundToLong

/** ICMP round trip to the confirmed exit, independent of the TCP/QUIC transport. */
internal object NodePing {
  internal fun validAddress(host: String): Boolean = host.split('.').let { parts ->
    parts.size == 4 && parts.all { it.isNotEmpty() && it.all(Char::isDigit) && (it.toIntOrNull() ?: -1) in 0..255 }
  }

  internal fun parse(output: String): Long? =
    Regex("time[=<]([0-9]+(?:\\.[0-9]+)?)\\s*ms").find(output)
      ?.groupValues?.get(1)?.toDoubleOrNull()?.roundToLong()?.coerceAtLeast(1)

  fun measure(host: String): Long? {
    if (!validAddress(host)) return null
    return runCatching {
      val builder = ProcessBuilder("/system/bin/ping", "-n", "-c", "1", "-W", "2", host)
        .redirectErrorStream(true)
      builder.environment()["LC_ALL"] = "C"
      val process = builder.start()
      try {
        if (!process.waitFor(3, TimeUnit.SECONDS)) null
        else process.inputStream.bufferedReader().use {
          val output = it.readText()
          val result = if (process.exitValue() == 0) parse(output) else null
          if (result == null) android.util.Log.d("magnetgate", "node echo unavailable: exit=${process.exitValue()}, permission=${output.contains("permitted") || output.contains("denied")}")
          result
        }
      } finally { process.destroy() }
    }.onFailure { android.util.Log.d("magnetgate", "node echo unavailable: ${it.javaClass.simpleName}") }.getOrNull()
  }
}
