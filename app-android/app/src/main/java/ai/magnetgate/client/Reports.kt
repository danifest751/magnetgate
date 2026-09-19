package ai.magnetgate.client

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * What this client tells its operator when it breaks, and - more importantly - what it does not.
 *
 * The application is about to be handed to people who are not its author. When their tunnel fails they
 * will not read a log, and nobody can ask them to; without something like this, every fault on every
 * phone but one is invisible. So a crash is written down and sent.
 *
 * The hard part is not sending. It is that this application knows exactly the things a person using it
 * would least like to have collected: the hosts their phone talks to, the addresses it resolves, the
 * relays and exits they reach. None of that may leave the device in a report, and "we will be careful"
 * is not a mechanism - so every string that goes into a report passes through [redact] first, and the
 * report carries no field that could hold a destination in the first place.
 *
 * What is sent:
 *
 *   - which build it was, on which Android version and which model of phone;
 *   - the exception: its class, its message and the frames belonging to this application;
 *   - whether the tunnel was up, and the last engine error the app had already shown on its own screen;
 *   - a random identifier for the installation, so two reports from one phone can be told apart from
 *     two phones - it is generated locally, has nothing to do with the device or the person, and is
 *     forgotten when the application is uninstalled.
 *
 * What is never sent: any host, address, domain, port, the key, the routing lists, the engine's log.
 */
object Reports {
  private const val TAG = "magnetgate"
  private const val DIR = "reports"

  /** More than this and something is wrong with the reporting, not with the client. */
  private const val MAX_REPORTS = 20
  private const val MAX_FRAMES = 12
  private const val MAX_MESSAGE = 400

  /**
   * Anything that could be a destination, removed before it can reach a report.
   *
   * Exception messages are where hosts leak: "dial tcp 203.0.113.7:443: i/o timeout" says where the
   * phone was going, and that is the one thing this file exists to keep. The rule is deliberately
   * blunt - an address-shaped or domain-shaped run of characters is replaced whether or not it was
   * sensitive. A report that says "connect: <host> refused" is still enough to act on; one that names
   * someone's bank is not acceptable even once.
   */
  fun redact(text: String): String = text
    .replace(Regex("""\b\d{1,3}(\.\d{1,3}){3}(:\d+)?"""), "<host>")
    .replace(Regex("""\[[0-9a-fA-F:]{2,}]()(:\d+)?"""), "<host>")
    .replace(Regex("""\b[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}(:\d+)?"""), "<host>")
    .take(MAX_MESSAGE)

  /** The identifier of this installation: local, random, and meaningless anywhere else. */
  fun installId(context: Context): String {
    val store = context.getSharedPreferences("magnetgate-reports", Context.MODE_PRIVATE)
    store.getString("id", null)?.let { return it }
    val id = java.util.UUID.randomUUID().toString().take(8)
    store.edit().putString("id", id).apply()
    return id
  }

  /** Whether reports may be sent at all. Visible and switchable on the settings screen. */
  fun enabled(context: Context): Boolean =
    context.getSharedPreferences("magnetgate-reports", Context.MODE_PRIVATE).getBoolean("enabled", true)

  fun setEnabled(context: Context, value: Boolean) {
    context.getSharedPreferences("magnetgate-reports", Context.MODE_PRIVATE)
      .edit().putBoolean("enabled", value).apply()
  }

  /**
   * Installs the handler that catches what nothing else caught.
   *
   * It writes the report and then hands the throwable to whatever handler was there before, so the
   * process still dies the way the system expects. Writing rather than sending is deliberate: a
   * process that is already dying is the worst possible moment to open a socket, and the watchdog will
   * have this application running again within the minute anyway.
   */
  fun catchCrashes(context: Context) {
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      runCatching { write(context, error, thread.name) }
      previous?.uncaughtException(thread, error)
    }
  }

  /** Writes one report. Also called for failures the application catches but cannot recover from. */
  fun write(context: Context, error: Throwable, where: String) {
    runCatching {
      val dir = File(context.filesDir, DIR).apply { mkdirs() }
      val existing = dir.listFiles()?.sortedBy { it.name }.orEmpty()
      // keep the oldest: the first failure after an update explains the ones that follow it
      if (existing.size >= MAX_REPORTS) return
      val frames = JSONArray()
      error.stackTrace.asSequence()
        .filter { it.className.startsWith("ai.magnetgate") }
        .take(MAX_FRAMES)
        .forEach { frames.put("${it.className}.${it.methodName}:${it.lineNumber}") }
      val report = JSONObject()
        .put("v", 1)
        .put("at", System.currentTimeMillis())
        .put("install", installId(context))
        .put("build", Updates.installedCode(context))
        .put("name", Updates.installedName(context))
        .put("android", android.os.Build.VERSION.RELEASE)
        .put("sdk", android.os.Build.VERSION.SDK_INT)
        .put("model", android.os.Build.MODEL)
        .put("where", where)
        .put("error", error.javaClass.name)
        .put("message", redact(error.message.orEmpty()))
        .put("frames", frames)
        .put("tunnel", MgVpnService.isRunning())
        .put("engineError", redact(Health.engineError))
      File(dir, "${System.currentTimeMillis()}.json").writeText(report.toString())
      Log.w(TAG, "report written: ${error.javaClass.simpleName} in $where")
    }.onFailure { Log.w(TAG, "writing a report: ${it.message}") }
  }

  /** The reports waiting to be sent, oldest first. */
  fun pending(context: Context): List<File> =
    File(context.filesDir, DIR).listFiles()?.sortedBy { it.name }.orEmpty()

  /**
   * Sends what is waiting, through the tunnel, and deletes what the node accepted.
   *
   * Through the tunnel and only through it. A report is never urgent - the crash already happened -
   * and a client that opened a plaintext connection to a fixed address the moment it crashed would be
   * describing itself to whoever is watching the network. Queued reports cost a few hundred bytes on
   * disk and wait for a tunnel, which the watchdog will have back within the minute.
   *
   * Each report is signed with a key derived from the group secret, so the node can throw away
   * anything that did not come from this group without reading it. That is the only thing the
   * signature is for: it is not a name, and two reports from one phone are linked by the random
   * install id, not by it.
   */
  fun send(context: Context, sink: String, socksPort: Int): Int {
    if (!enabled(context) || sink.isBlank() || socksPort == 0) return 0
    val secret = Settings.psk(context)
    if (secret.isBlank()) return 0
    var sent = 0
    for (file in pending(context)) {
      val body = runCatching { file.readText() }.getOrNull() ?: continue
      val ok = runCatching { post(sink, socksPort, body, sign(secret, body)) }
        .onFailure { Log.w(TAG, "sending a report: ${it.message}") }
        .getOrDefault(false)
      if (!ok) break // the node is unreachable; the rest can wait with it
      runCatching { file.delete() }
      sent++
    }
    if (sent > 0) Log.i(TAG, "sent $sent report(s)")
    return sent
  }

  private fun sign(secret: String, body: String): String {
    val key = java.security.MessageDigest.getInstance("SHA-256")
      .digest(("mgt-report:" + secret).toByteArray())
    val mac = javax.crypto.Mac.getInstance("HmacSHA256")
    mac.init(javax.crypto.spec.SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(body.toByteArray()).joinToString("") { "%02x".format(it) }
  }

  /** One POST, written by hand over the core's listener, for the reasons in Updates.fetch. */
  private fun post(sink: String, socksPort: Int, body: String, signature: String): Boolean {
    val url = java.net.URL(sink)
    if (url.protocol != "http" && url.protocol != "https") return false
    val port = if (url.port != -1) url.port else if (url.protocol == "https") 443 else 80
    val path = url.path.ifEmpty { "/" }
    val socket = java.net.Socket(java.net.Proxy(java.net.Proxy.Type.SOCKS, java.net.InetSocketAddress("127.0.0.1", socksPort)))
    socket.soTimeout = 20_000
    socket.connect(java.net.InetSocketAddress.createUnresolved(url.host, port), 20_000)
    socket.use {
      val stream: java.net.Socket = if (url.protocol == "https") {
        (javax.net.ssl.SSLSocketFactory.getDefault() as javax.net.ssl.SSLSocketFactory)
          .createSocket(it, url.host, port, false).also { tls -> (tls as javax.net.ssl.SSLSocket).startHandshake() }
      } else {
        it
      }
      val bytes = body.toByteArray()
      val writer = stream.getOutputStream()
      writer.write(
        ("POST $path HTTP/1.1\r\n" +
          "Host: ${url.host}\r\n" +
          "Content-Type: application/json\r\n" +
          "Content-Length: ${bytes.size}\r\n" +
          "X-MG-Auth: $signature\r\n" +
          "Connection: close\r\n\r\n").toByteArray()
      )
      writer.write(bytes)
      writer.flush()
      val status = stream.getInputStream().bufferedReader().readLine().orEmpty()
      return status.contains(" 200") || status.contains(" 204")
    }
  }
}
