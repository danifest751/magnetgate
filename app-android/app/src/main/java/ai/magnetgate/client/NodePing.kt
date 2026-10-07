package ai.magnetgate.client

import java.util.concurrent.TimeUnit
import kotlin.math.roundToLong

/** ICMP round trip to the confirmed exit, independent of the TCP/QUIC transport. */
internal object NodePing {
  internal fun validAddress(host: String): Boolean = host.split('.').let { parts ->
    parts.size == 4 && parts.all { it.isNotEmpty() && it.all(Char::isDigit) && (it.toIntOrNull() ?: -1) in 0..255 }
  }

  internal fun parse(output: String): Long? {
    val replies = Regex("time[=<]([0-9]+(?:\\.[0-9]+)?)\\s*ms").findAll(output)
      .mapNotNull { it.groupValues[1].toDoubleOrNull() }.toList()
    return replies.takeIf { it.isNotEmpty() }?.average()?.roundToLong()?.coerceAtLeast(1)
  }

  fun measure(host: String): Long? {
    if (!validAddress(host)) return null
    return runCatching {
      // A single lost datagram must not erase an otherwise measurable node. The entire batch is
      // bounded to two seconds; its average includes only actual replies, never failed attempts.
      val builder = ProcessBuilder("/system/bin/ping", "-n", "-c", "3", "-i", "0.2", "-W", "1", "-w", "2", host)
        .redirectErrorStream(true)
      builder.environment()["LC_ALL"] = "C"
      val process = builder.start()
      try {
        if (!process.waitFor(3, TimeUnit.SECONDS)) null
        else process.inputStream.bufferedReader().use {
          val output = it.readText()
          // ping may return nonzero on partial loss despite having valid replies before its deadline.
          val result = parse(output)
          if (result == null) android.util.Log.d("magnetgate", "node echo unavailable: exit=${process.exitValue()}, permission=${output.contains("permitted") || output.contains("denied")}")
          result
        }
      } finally { process.destroy() }
    }.onFailure { android.util.Log.d("magnetgate", "node echo unavailable: ${it.javaClass.simpleName}") }.getOrNull()
  }
}
