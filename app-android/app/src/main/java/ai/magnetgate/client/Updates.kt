package ai.magnetgate.client

import android.content.BroadcastReceiver
import android.content.Context
import android.app.Notification
import android.content.Intent
import android.content.IntentFilter
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
      Log.w(TAG, "the update hook is for adb on a debuggable build, and this launch is neither")
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

  /**
   * How much of the tunnel this download is allowed to take, and how many streams it takes it with.
   *
   * Four streams and no ceiling is what shipped, and on 20.09 it made the client unusable while it
   * updated. Measured on the owner's phone, on Wi-Fi: the tunnel itself tops out near 6 Mbit/s
   * (764 KB/s from the node, 745 KB/s from a public CDN - the ceiling is the tunnel, not the source),
   * and four slices take all of it. Nothing was starved of bandwidth; everything was starved of *turn*.
   * A request that took 0.5 s idle took 12 s, the engine reported 15-19 s deadlines on new connections,
   * the exit check failed three times running - and the phone was 90% idle throughout, so it was never
   * about the processor either. It was a full queue.
   *
   * The cure for a full queue is not to fill it. The download paces itself well under the ceiling and
   * leaves the rest for the person using the phone, which is the whole point of the client; 88 MB at
   * this rate is minutes, and minutes in the background are free. It also stops the loop that made it
   * worse: slices that time out behind their own queue are re-queued, which opens more connections,
   * which lengthens the queue (the record of what was left grew 15 -> 17 -> 19 while it "downloaded").
   */
  private const val WORKERS = 2
  private const val RATE_START = 1536L * 1024
  private const val RATE_FLOOR = 64L * 1024
  private const val RATE_CEIL = 4096L * 1024

  /** How many times one slice is taken again, on its own, before the whole attempt is called failed. */
  private const val SLICE_TRIES = 4

  /**
   * What the download watches while it runs: how long the tunnel takes to open a new connection.
   *
   * Not throughput, and not the package's own progress - both of those look healthy while everything
   * else on the phone is stuck behind a full queue. A new connection is what a person is waiting for
   * when they open something, and it is what failed on 20.09: 0.5 s idle, 12 s under the download,
   * 15-19 s deadlines in the engine. So that is the number the rate answers to, measured every few
   * seconds through the core, exactly as the person's own traffic goes.
   */
  private const val PROBE_EVERY_MS = 3_000L
  private const val HURTS_MS = 2_000L
  private const val FINE_MS = 900L

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

  /**
   * Holds the download to a rate, and lowers it when the tunnel says it is hurting.
   *
   * A token bucket, shared by every worker: a slice asks before it keeps what it read, and waits when
   * the bucket is empty. Waiting is the point - an unpaced bulk transfer fills the queue on the way
   * out, and everything else on the phone then waits behind it (see the comment on RATE_START).
   *
   * The rate is not fixed, because no single number is right on every network. It starts low, climbs
   * while the exit check keeps coming back quickly, and halves the moment a check fails or crawls.
   * That check runs on its own timer for its own reasons; here it is used as the one honest answer to
   * "is this download in someone's way", measured through the same tunnel by code that knows nothing
   * about updates.
   */
  private class Pacer(@Volatile var rate: Long) {
    private val lock = Object()
    private var allowance = 0.0
    private var last = System.nanoTime()

    fun take(bytes: Int) {
      while (true) {
        val sleepMs: Long
        synchronized(lock) {
          val now = System.nanoTime()
          allowance = minOf(allowance + (now - last) / 1e9 * rate, rate.toDouble())
          last = now
          if (allowance >= bytes) {
            allowance -= bytes
            return
          }
          sleepMs = (((bytes - allowance) / rate) * 1000).toLong().coerceIn(1, 250)
        }
        Thread.sleep(sleepMs)
      }
    }

    /**
     * Moves the rate after each measurement of how long a new connection now takes.
     *
     * Fast, because the thing being protected is fast: a person opening a page waits seconds, not
     * minutes, and a regulator that learns once a minute either starves them for a minute or crawls
     * for the whole download. The first version did the latter, which is the same failure wearing the
     * other hat - the update took forever and the owner said so.
     */
    fun steer(connectMs: Long) {
      val was = rate
      rate = when {
        connectMs > HURTS_MS -> maxOf(RATE_FLOOR, rate / 2)
        connectMs < FINE_MS -> minOf(RATE_CEIL, rate + rate / 4)
        else -> rate
      }
      if (rate != was) {
        Log.i(TAG, "update rate ${was / 1024} -> ${rate / 1024} KB/s (an answer took ${if (connectMs == Long.MAX_VALUE) "forever" else connectMs.toString() + "ms"})")
      }
    }
  }

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
  fun download(
    context: Context,
    update: UpdateRow,
    socksPort: Int,
    planes: List<EnginePlane> = emptyList(),
    onProgress: (Progress) -> Unit,
  ): File? {
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
        fetch(update, socksPort, planes, target, onProgress)
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
  private fun fetch(
    update: UpdateRow,
    socksPort: Int,
    planes: List<EnginePlane>,
    target: File,
    onProgress: (Progress) -> Unit,
  ) {
    // The fastest road first, another only when it will not carry.
    //
    // Which road that is no longer lives here. This file used to name hy2 itself, from its own
    // measurement, while two other files named reality from a different one - four declarations of one
    // decision, disagreeing. The order is now `CoreConfig.PREFERENCE`, and the measurement behind it is
    // in `src/health.mjs`. This file turned out to have been right all along, and that is not a defence:
    // being right privately is exactly how the four of them drifted apart.
    //
    // What stays here is the shape: every slice starts on the best road the node set actually offers,
    // spread across the nodes that have it; a slice that fails takes the next road down, ending at the
    // core itself, which can always find *a* way.
    val roads = (planes.map { it.port } + socksPort).distinct()
    val first = CoreConfig.PREFERENCE
      .firstNotNullOfOrNull { plane -> planes.filter { it.plane == plane }.map { it.port }.ifEmpty { null } }
      ?: roads
    val total = update.bytes
    val pieces = ((total + PIECE - 1) / PIECE).toInt()
    // the file is laid out in full once, so that any slice may be written at its own offset
    java.io.RandomAccessFile(target, "rw").use { it.setLength(total) }
    val done = java.util.Collections.synchronizedSet(readDone(target).toMutableSet())
    val next = java.util.concurrent.atomic.AtomicInteger(0)
    val failure = java.util.concurrent.atomic.AtomicReference<Throwable?>(null)
    val fetched = java.util.concurrent.atomic.AtomicLong(done.size.toLong() * PIECE)

    val pacer = Pacer(RATE_START)
    // The tunnel's own opinion, read as it arrives. The check runs on the service's timer and knows
    // nothing about updates, which is exactly what makes it worth listening to here.
    val watched = URL(update.url)
    val watchedPort = if (watched.port != -1) watched.port else if (watched.protocol == "https") 443 else 80
    val steering = Thread {
      while (true) {
        pacer.steer(firstByteMs(socksPort, watched, watchedPort))
        try {
          Thread.sleep(PROBE_EVERY_MS)
        } catch (_: InterruptedException) {
          return@Thread
        }
      }
    }.apply { isDaemon = true; start() }

    val workers = (1..minOf(WORKERS, maxOf(1, pieces - done.size))).map {
      Thread {
        while (failure.get() == null) {
          val piece = next.getAndIncrement()
          if (piece >= pieces) return@Thread
          if (!done.add(piece)) continue // already on disk from an earlier attempt
          val from = piece.toLong() * PIECE
          val to = minOf(from + PIECE, total) - 1
          var taken = false
          var last: Throwable? = null
          // One slice failing used to fail the whole round: every other worker stopped, and the next
          // attempt opened all its connections again from the top. On a tunnel that was slow *because
          // of this download*, that is a storm and not a retry. A slice that timed out is a slice that
          // was slow - the same distinction the layer policy had to learn on 19.09 - so it is taken
          // again on its own, more gently each time, and only a slice that cannot be had at all fails
          // the attempt.
          for (attempt in 1..SLICE_TRIES) {
            if (failure.get() != null) break
            try {
              val road = if (attempt == 1) first[piece % first.size] else roads[(piece + attempt) % roads.size]
              slice(road, target, from, to, pacer, update.url)
              taken = true
              break
            } catch (error: Throwable) {
              last = error
              Log.w(TAG, "update slice $piece, try $attempt of $SLICE_TRIES: ${error.message}")
              pacer.rate = maxOf(RATE_FLOOR, pacer.rate / 2)
              try {
                Thread.sleep(1_000L * attempt)
              } catch (_: InterruptedException) {
                return@Thread
              }
            }
          }
          if (!taken) {
            done.remove(piece) // it is not done, and the next attempt has to take it again
            failure.compareAndSet(null, last ?: IllegalStateException("slice $piece did not arrive"))
            return@Thread
          }
          noteDone(target, piece)
          val got = fetched.addAndGet(to - from + 1)
          onProgress(Progress.Downloading(minOf(got, total), total))
        }
      }.apply { isDaemon = true; start() }
    }
    workers.forEach { it.join() }
    steering.interrupt()
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

  /**
   * How long the tunnel takes to get an answer **from the far side** right now, or [Long.MAX_VALUE].
   *
   * A first version of this timed the SOCKS connect and was proud of 2 ms - which is trap 92 of this
   * project, made a second time by the same hands: the core answers a SOCKS request before it has
   * dialled anything, so that number is the same whether the road is clear, jammed, or gone. It sent
   * the rate straight to the ceiling while claiming the tunnel was perfect.
   *
   * So the probe asks for something and waits for the first byte of the reply. Through the core,
   * because that is the road the person's own traffic takes, and to the machine already serving this
   * package, because it is ours and one HEAD costs it nothing.
   */
  private fun firstByteMs(socksPort: Int, url: URL, port: Int): Long {
    val started = System.nanoTime()
    return try {
      Socket(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort))).use { probe ->
        probe.soTimeout = 5_000
        probe.connect(InetSocketAddress.createUnresolved(url.host, port), 5_000)
        val path = url.path.ifEmpty { "/" }
        val request = "HEAD $path HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n"
        probe.getOutputStream().apply { write(request.toByteArray()); flush() }
        if (probe.getInputStream().read() < 0) return Long.MAX_VALUE
      }
      (System.nanoTime() - started) / 1_000_000
    } catch (_: Throwable) {
      Long.MAX_VALUE
    }
  }

  /** One slice, over its own connection through the tunnel, at no more than the pacer allows. */
  private fun slice(proxyPort: Int, target: File, from: Long, to: Long, pacer: Pacer, source: String) {
    var url = URL(source)
    var redirects = 0
    while (true) {
      if (url.protocol != "http" && url.protocol != "https") {
        throw IllegalStateException("the update source is not an http address")
      }
      val host = url.host
      val port = if (url.port != -1) url.port else if (url.protocol == "https") 443 else 80
      val path = (url.path.ifEmpty { "/" }) + (url.query?.let { "?$it" } ?: "")
      // proxyPort, not port: `port` a few lines up is the *destination's* port, and naming the proxy
      // the same thing made every slice dial 127.0.0.1:45443 and be refused. Cost: one round of
      // builds at one in the morning.
      val socket = Socket(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", proxyPort)))
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
                // Asked for after the bytes are safely on disk, so a wait never holds a half-written
                // buffer; the socket's own window does the rest of the work upstream.
                pacer.take(read)
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

  private const val INSTALL_STATUS = "ai.magnetgate.client.INSTALL_STATUS"

  /**
   * Hands the verified package to the system installer, which asks the person.
   *
   * The session is written from our own file and committed; Android then checks the signature against
   * the installed application and refuses if they differ. That refusal is a feature: it is what makes a
   * stolen update URL useless without the release key.
   *
   * The dialog is raised by **us**, and that is the whole lesson of 20.09. The session used to be
   * committed with a PendingIntent to this application's activity, leaving the system to bring the
   * confirmation up; on the owner's phone the system refused - `abortLaunch` in the log,
   * `SYSTEM_ALERT_WINDOW: default; rejectTime=+43s` in appops, four sessions committed and four
   * aborts in a second and a half, and nothing whatsoever on screen while the person tapped again and
   * again. A PendingIntent that starts an activity is judged as a start from the background, and MIUI
   * does not allow that without a permission nobody has granted.
   *
   * So the session reports to a broadcast receiver, which always arrives, and the intent it hands back
   * under STATUS_PENDING_USER_ACTION is started by [onConfirm] from the activity the person is looking
   * at. That is an ordinary foreground start, and it needs no permission at all.
   */
  fun install(context: Context, apk: File, onConfirm: (Intent) -> Unit): Boolean = runCatching {
    val installer = context.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
    params.setAppPackageName(context.packageName)
    val sessionId = installer.createSession(params)
    val application = context.applicationContext
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty()
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
          val confirm = if (android.os.Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
          } else {
            @Suppress("DEPRECATION") intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
          }
          if (confirm == null) Log.w(TAG, "the installer asked for a person without saying how")
          else onConfirm(confirm)
          return // the session lives on; the answer comes as another broadcast
        }
        Log.i(TAG, "installer session $sessionId: status $status $message")
        runCatching { application.unregisterReceiver(this) }
      }
    }
    val filter = IntentFilter(INSTALL_STATUS)
    if (android.os.Build.VERSION.SDK_INT >= 33) {
      application.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag") application.registerReceiver(receiver, filter)
    }
    installer.openSession(sessionId).use { session ->
      session.openWrite("package", 0, apk.length()).use { output ->
        apk.inputStream().use { it.copyTo(output, CHUNK) }
        session.fsync(output)
      }
      val intent = Intent(INSTALL_STATUS).setPackage(context.packageName)
      val flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_MUTABLE
      val pending = android.app.PendingIntent.getBroadcast(context, sessionId, intent, flags)
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
