package ai.magnetgate.client

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import java.security.MessageDigest

/**
 * Updating the client from the client.
 *
 * There is no store here. The application is side-loaded, signed with a key that lives outside this
 * repository, and used on a network where the usual places to fetch a package from are not reachable
 * without it - so the update has to travel the same road as everything else: the exit advertises it,
 * the phone fetches it **through its own tunnel**, and a person installs it.
 *
 * Acting on an update means installing code, which is the most dangerous thing this application can be
 * asked to do. Four independent things have to hold, and no one of them is trusted alone:
 *
 *  1. **The manifest is sealed.** It travels inside the offer, encrypted under the key derived from the
 *     PSK, so only the holder of the group key can say that an update exists (core/offer.Update).
 *  2. **The package is hashed.** Whatever the URL serves is verified against the digest from that
 *     manifest before anything else happens; a mirror serving something else fails here. The URL
 *     itself is not trusted and does not have to be, exactly as for the routing lists.
 *  3. **Android checks the signature.** A package signed with a different key cannot be installed over
 *     this one - that is the system's rule, not ours, and it is the gate an attacker without the
 *     release key cannot pass even if the three others somehow fell.
 *  4. **A person installs it.** The system asks, in its own dialog. Nothing here installs silently, and
 *     nothing downloads without being asked either: the package is some 85 MB, and a client that
 *     helped itself to that on a mobile network would be a bad guest.
 */
object Updates {
  private const val TAG = "magnetgate"

  /**
   * A manifest handed to this build from a shell, for an acceptance run, and only in a debuggable one.
   *
   * The live path needs a node to advertise an update and a package published where an exit can reach
   * it; neither belongs in a test of the client's own half - the download through the tunnel, the
   * digest, and what the installer does with the result. So a run can supply the manifest directly and
   * exercise all of that against a file whose digest is known.
   *
   * It is a launch extra like the others here (`-e update '<json>'`), it dies with the process, and a
   * release build ignores it entirely: this is the one field in this application that decides what code
   * gets installed, and a release must take it from the sealed offer and nowhere else.
   */
  @Volatile
  var injected: UpdateRow? = null
    private set

  fun inject(json: String, debuggable: Boolean) {
    if (!debuggable) {
      Log.w(TAG, "the update hook only exists in debuggable builds")
      return
    }
    injected = runCatching {
      val entry = org.json.JSONObject(json)
      UpdateRow(
        versionCode = entry.getLong("vc"),
        versionName = entry.getString("vn"),
        url = entry.getString("url"),
        sha256 = entry.getString("sha256"),
        bytes = entry.getLong("bytes"),
      )
    }.onFailure { Log.w(TAG, "the injected manifest is not one: ${it.message}") }.getOrNull()
    injected?.let { Log.w(TAG, "acceptance hook: pretending build ${it.versionCode} is advertised") }
  }

  /** Where the package is kept while it is being checked. One at a time; replaced on every attempt. */
  private const val FILE = "update.apk"

  /** Read in chunks so that a phone never holds 85 MB twice: once in a buffer and once in a file. */
  private const val CHUNK = 64 * 1024

  /**
   * The update worth offering, or null.
   *
   * "Worth offering" is a higher version code than the one installed - Android's own counter, and the
   * only comparison that means anything. A manifest naming the installed build, or an older one, is
   * not an update: it is a downgrade the system would refuse anyway.
   */
  fun offered(context: Context, advertised: UpdateRow?): UpdateRow? {
    val advertised = injected ?: advertised
    if (advertised == null) return null
    val installed = installedCode(context)
    return if (advertised.versionCode > installed) advertised else null
  }

  fun installedCode(context: Context): Long = runCatching {
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
  }.getOrDefault(0L)

  fun installedName(context: Context): String = runCatching {
    context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty()
  }.getOrDefault("")

  /** What a download is doing, for the screen. */
  sealed interface Progress {
    data class Downloading(val bytes: Long, val total: Long) : Progress
    data class Failed(val why: String) : Progress
    data object Verified : Progress
  }

  /**
   * Fetches the package through the tunnel and verifies it against the manifest.
   *
   * Through `socksPort` - the core's own listener - for the same reason the routing lists go that way:
   * on the network this client exists for, the place a release is published is often exactly what is
   * unreachable. The size is checked against the manifest as it arrives rather than afterwards, so a
   * source that decides to serve a hundred gigabytes cannot fill the phone before anyone notices.
   *
   * Returns the verified file, or null; every failure leaves nothing behind and is reported rather
   * than thrown.
   */
  fun download(context: Context, update: UpdateRow, socksPort: Int, onProgress: (Progress) -> Unit): File? {
    val target = File(context.filesDir, FILE)
    runCatching { target.delete() }
    val url = runCatching { URL(update.url) }.getOrNull()
    if (url == null || url.protocol != "https") {
      onProgress(Progress.Failed("the update source is not an https address"))
      return null
    }
    return try {
      val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort))
      val connection = (url.openConnection(proxy) as HttpURLConnection).apply {
        connectTimeout = 30_000
        readTimeout = 60_000
        instanceFollowRedirects = true
      }
      connection.inputStream.use { input ->
        if (connection.responseCode != 200) throw IllegalStateException("HTTP ${connection.responseCode}")
        val digest = MessageDigest.getInstance("SHA-256")
        var written = 0L
        target.outputStream().use { output ->
          val buffer = ByteArray(CHUNK)
          while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            written += read
            if (written > update.bytes) throw IllegalStateException("the source is serving more than the manifest promised")
            digest.update(buffer, 0, read)
            output.write(buffer, 0, read)
            onProgress(Progress.Downloading(written, update.bytes))
          }
        }
        if (written != update.bytes) throw IllegalStateException("got $written B of ${update.bytes} B")
        val got = digest.digest().joinToString("") { "%02x".format(it) }
        if (!got.equals(update.sha256, ignoreCase = true)) {
          throw IllegalStateException("the package does not match the manifest")
        }
      }
      Log.i(TAG, "update ${update.versionCode} downloaded and verified")
      onProgress(Progress.Verified)
      target
    } catch (error: Throwable) {
      runCatching { target.delete() }
      Log.w(TAG, "update ${update.versionCode}: ${error.message}")
      onProgress(Progress.Failed(error.message ?: error.javaClass.simpleName))
      null
    }
  }

  /**
   * Hands the verified package to the system installer, which asks the person.
   *
   * The session is written from our own file and committed; Android then shows its dialog, checks the
   * signature against the installed application and refuses if they differ. That refusal is a feature:
   * it is what makes a stolen update URL useless without the release key.
   */
  fun install(context: Context, apk: File): Boolean = runCatching {
    val installer = context.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
    params.setAppPackageName(context.packageName)
    val sessionId = installer.createSession(params)
    installer.openSession(sessionId).use { session ->
      session.openWrite("package", 0, apk.length()).use { output ->
        apk.inputStream().use { it.copyTo(output, CHUNK) }
        session.fsync(output)
      }
      val intent = Intent(context, MainActivity::class.java)
      val flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_MUTABLE
      val pending = android.app.PendingIntent.getActivity(context, sessionId, intent, flags)
      session.commit(pending.intentSender)
    }
    Log.i(TAG, "update handed to the system installer, session $sessionId")
    true
  }.onFailure { Log.w(TAG, "handing the update to the installer: ${it.message}") }.getOrDefault(false)

  /** Whether this phone allows this app to install packages at all; without it the dialog never opens. */
  fun mayInstall(context: Context): Boolean =
    android.os.Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

  /** The screen sends a person here to allow it, once. */
  fun permissionIntent(context: Context): Intent =
    Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
      .setData(android.net.Uri.parse("package:" + context.packageName))
}
