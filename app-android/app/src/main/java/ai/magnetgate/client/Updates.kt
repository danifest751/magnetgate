package ai.magnetgate.client

import android.content.Context
import android.app.Notification
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import java.io.File
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.URL
import java.security.MessageDigest
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

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

  /** How much of the package one slice covers, and how many slices travel at once. */
  private const val PIECE = 4L * 1024 * 1024
  private const val WORKERS = 4

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

  /**
   * The build whose package is downloaded, verified and waiting to be installed, or 0.
   *
   * There has to be such a state, because the last step of an update needs a person and the download
   * does not. Android aborts an install dialog launched from the background - measured: the package
   * arrived seven minutes after the screen had moved on, the session was committed, and the system
   * wrote `abortLaunch` and showed nothing. A silent nothing is the worst possible outcome for an
   * update, so the verified package waits, the screen offers it, and the notification says so.
   */
  fun stagedBuild(context: Context): Long {
    val code = context.getSharedPreferences("magnetgate-update", Context.MODE_PRIVATE).getLong("ready", 0)
    if (code == 0L) return 0
    return if (File(context.filesDir, FILE).exists()) code else 0
  }

  private fun rememberStaged(context: Context, versionCode: Long) {
    context.getSharedPreferences("magnetgate-update", Context.MODE_PRIVATE)
      .edit().putLong("ready", versionCode).apply()
  }

  /** Forgets a staged package once it is installed, or once it is no longer the one being offered. */
  fun forgetStaged(context: Context) {
    val target = File(context.filesDir, FILE)
    runCatching { target.delete() }
    runCatching { partsFile(target).delete() }
    context.getSharedPreferences("magnetgate-update", Context.MODE_PRIVATE)
      .edit().remove("ready").remove("partial").apply()
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
    // A part-file from an earlier attempt is an asset, not rubbish: the first live download of this
    // took half an hour and then died at 47 of 88 MB, and starting from zero is how a phone on a
    // mobile network never finishes an update at all. What is kept is the slices, not the file: the
    // file is laid out full-length from the start, so its size says nothing about what is in it.
    // The record of finished slices must never outlive the file it describes. An earlier version
    // deleted the package on failure and left the record behind; the next attempt then trusted it,
    // wrote nothing, and failed the digest with every slice "done" - which reads like corruption and
    // is really bookkeeping. So the two are checked together, and dropped together.
    val stale = partialFor(context) != update.versionCode ||
      !target.exists() ||
      target.length() != update.bytes
    if (stale) {
      runCatching { target.delete() }
      runCatching { partsFile(target).delete() }
    }
    rememberPartial(context, update.versionCode)
    val pieces = ((update.bytes + PIECE - 1) / PIECE).toInt()

    var attempt = 0
    while (true) {
      attempt++
      try {
        fetch(update, socksPort, target, onProgress)
        Log.i(TAG, "update ${update.versionCode} downloaded and verified")
        rememberStaged(context, update.versionCode)
        onProgress(Progress.Verified)
        return target
      } catch (error: Throwable) {
        val have = readDone(target).size
        Log.w(TAG, "update ${update.versionCode}: ${error.message} ($have of $pieces slices)")
        if (attempt >= MAX_ATTEMPTS) {
          // Whatever is on disk is either wrong or not worth the space; the slices that did arrive are
          // no use once this build is no longer the one being offered.
          runCatching { target.delete() }
          runCatching { partsFile(target).delete() }
          onProgress(Progress.Failed(error.message ?: error.javaClass.simpleName))
          return null
        }
        onProgress(Progress.Downloading(have.toLong() * PIECE, update.bytes))
      }
    }
  }

  /** How many times a stalled download is picked up again before the person is told it failed. */
  private const val MAX_ATTEMPTS = 6

  private fun partialFor(context: Context): Long =
    context.getSharedPreferences("magnetgate-update", Context.MODE_PRIVATE).getLong("partial", 0)

  private fun rememberPartial(context: Context, versionCode: Long) {
    context.getSharedPreferences("magnetgate-update", Context.MODE_PRIVATE)
      .edit().putLong("partial", versionCode).apply()
  }

  /**
   * Fetches the package in slices, several at a time, and writes each where it belongs.
   *
   * One stream was not enough. Measured on the owner's phone: the same package that arrived in 170
   * seconds one evening managed 47 of 88 MB in half an hour the next, because the tunnel happened to
   * leave through the exit that is not the one hosting the file, and one TCP stream across that extra
   * hop is what it is. Four slices in parallel do not make the hop faster, but one stalled window no
   * longer holds up everything behind it, and every slice that finishes is finished for good.
   *
   * The slices are small on purpose. A slice is the unit of resuming: with four-megabyte pieces a
   * stall costs at most four megabytes rather than the whole package, and the record of what is done
   * outlives the process - which, on a phone that is updating its own VPN, may well die mid-way.
   */
  private fun fetch(update: UpdateRow, socksPort: Int, target: File, onProgress: (Progress) -> Unit) {
    val total = update.bytes
    val pieces = ((total + PIECE - 1) / PIECE).toInt()
    // the file is laid out in full once, so that any slice may be written at its own offset
    java.io.RandomAccessFile(target, "rw").use { it.setLength(total) }
    val done = java.util.Collections.synchronizedSet(readDone(target).toMutableSet())
    val next = java.util.concurrent.atomic.AtomicInteger(0)
    val failure = java.util.concurrent.atomic.AtomicReference<Throwable?>(null)
    val fetched = java.util.concurrent.atomic.AtomicLong(done.size.toLong() * PIECE)

    val workers = (1..minOf(WORKERS, maxOf(1, pieces - done.size))).map {
      Thread {
        while (failure.get() == null) {
          val piece = next.getAndIncrement()
          if (piece >= pieces) return@Thread
          if (!done.add(piece)) continue // already on disk from an earlier attempt
          val from = piece.toLong() * PIECE
          val to = minOf(from + PIECE, total) - 1
          try {
            slice(update, socksPort, target, from, to)
            noteDone(target, piece)
            val got = fetched.addAndGet(to - from + 1)
            onProgress(Progress.Downloading(minOf(got, total), total))
          } catch (error: Throwable) {
            done.remove(piece) // it is not done, and the next attempt has to take it again
            failure.compareAndSet(null, error)
            return@Thread
          }
        }
      }.apply { isDaemon = true; start() }
    }
    workers.forEach { it.join() }
    failure.get()?.let { throw it }

    // Hashed from the finished file rather than in flight: the bytes arrived over several connections
    // and possibly several attempts, so a digest of any one stream would prove nothing about the rest.
    val digest = MessageDigest.getInstance("SHA-256")
    target.inputStream().use { file ->
      val buffer = ByteArray(CHUNK)
      while (true) {
        val read = file.read(buffer)
        if (read <= 0) break
        digest.update(buffer, 0, read)
      }
    }
    val got = digest.digest().joinToString("") { "%02x".format(it) }
    if (!got.equals(update.sha256, ignoreCase = true)) {
      throw IllegalStateException("the package does not match the manifest")
    }
    runCatching { partsFile(target).delete() }
  }

  /** One slice, over its own connection through the tunnel. */
  private fun slice(update: UpdateRow, socksPort: Int, target: File, from: Long, to: Long) {
    var url = URL(update.url)
    var redirects = 0
    while (true) {
      if (url.protocol != "http" && url.protocol != "https") {
        throw IllegalStateException("the update source is not an http address")
      }
      val host = url.host
      val port = if (url.port != -1) url.port else if (url.protocol == "https") 443 else 80
      val path = (url.path.ifEmpty { "/" }) + (url.query?.let { "?$it" } ?: "")
      val socket = Socket(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort)))
      socket.soTimeout = 60_000
      socket.connect(InetSocketAddress.createUnresolved(host, port), 30_000)
      var redirect: String? = null
      socket.use {
        val stream: Socket = if (url.protocol == "https") {
          (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(it, host, port, false).also { tls ->
            (tls as SSLSocket).startHandshake()
          }
        } else {
          it
        }
        val writer = stream.getOutputStream().bufferedWriter()
        writer.write(
          "GET $path HTTP/1.1\r\nHost: $host\r\nRange: bytes=$from-$to\r\n" +
            "Connection: close\r\nUser-Agent: magnetgate\r\n\r\n"
        )
        writer.flush()
        val input = stream.getInputStream()
        val status = readLine(input) ?: throw IllegalStateException("the source answered with nothing")
        val code = status.split(' ').getOrNull(1)?.toIntOrNull() ?: 0
        var location: String? = null
        while (true) {
          val header = readLine(input) ?: throw IllegalStateException("the answer ended inside its headers")
          if (header.isEmpty()) break
          if (header.startsWith("Location:", ignoreCase = true)) location = header.substringAfter(':').trim()
        }
        when {
          code in 300..399 && location != null -> redirect = location
          // 200 would mean the source ignored the range and is sending the whole package per slice
          code != 206 -> throw IllegalStateException("HTTP $code for bytes $from-$to")
          else -> {
            val want = to - from + 1
            var written = 0L
            java.io.RandomAccessFile(target, "rw").use { file ->
              file.seek(from)
              val buffer = ByteArray(CHUNK)
              while (written < want) {
                val read = input.read(buffer, 0, minOf(CHUNK.toLong(), want - written).toInt())
                if (read <= 0) break
                file.write(buffer, 0, read)
                written += read
              }
            }
            if (written != want) throw IllegalStateException("slice $from-$to: got $written of $want B")
          }
        }
      }
      val nextUrl = redirect ?: return
      if (++redirects > 3) throw IllegalStateException("too many redirects")
      url = URL(url, nextUrl)
    }
  }

  private fun partsFile(target: File) = File(target.parentFile, target.name + ".parts")

  /** Which slices are already on disk, from an attempt that did not finish. */
  private fun readDone(target: File): Set<Int> = runCatching {
    partsFile(target).readLines().mapNotNull { it.trim().toIntOrNull() }.toSet()
  }.getOrDefault(emptySet())

  @Synchronized
  private fun noteDone(target: File, piece: Int) {
    runCatching { partsFile(target).appendText(piece.toString() + "\n") }
  }

  /** One CRLF-terminated line, read byte by byte because the body after it must stay unbuffered. */
  private fun readLine(input: java.io.InputStream): String? {
    val line = StringBuilder()
    while (true) {
      val byte = input.read()
      if (byte < 0) return if (line.isEmpty()) null else line.toString()
      if (byte == '\n'.code) return line.toString().trimEnd('\r')
      line.append(byte.toChar())
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

  /**
   * Says in the shade that a package is ready, because the dialog cannot be raised from the background.
   *
   * Tapping it opens this application, which is the only place the install can be started from with
   * any chance of the system showing its dialog.
   */
  fun announce(context: Context, update: UpdateRow) {
    runCatching {
      val manager = context.getSystemService(android.app.NotificationManager::class.java) ?: return
      val open = android.app.PendingIntent.getActivity(
        context,
        1,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
      )
      val notification = Notification.Builder(context, "magnetgate")
        .setContentTitle(context.getString(R.string.update_ready_title))
        .setContentText(context.getString(R.string.update_ready_text, update.versionCode))
        .setSmallIcon(R.drawable.ic_launcher_monochrome)
        .setContentIntent(open)
        .setAutoCancel(true)
        .build()
      manager.notify(UPDATE_NOTIFICATION, notification)
    }.onFailure { Log.w(TAG, "announcing the update: ${it.message}") }
  }

  fun withdrawAnnouncement(context: Context) {
    runCatching {
      context.getSystemService(android.app.NotificationManager::class.java)?.cancel(UPDATE_NOTIFICATION)
    }
  }

  private const val UPDATE_NOTIFICATION = 2

  /** Whether this phone allows this app to install packages at all; without it the dialog never opens. */
  fun mayInstall(context: Context): Boolean =
    android.os.Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

  /** The screen sends a person here to allow it, once. */
  fun permissionIntent(context: Context): Intent =
    Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
      .setData(android.net.Uri.parse("package:" + context.packageName))
}
