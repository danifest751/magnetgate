package ai.magnetgate.client

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The in-app wallet for payment channels: one Requant key file and at most one channel at a time.
 *
 * The key file is the standard requant-wallet format, encrypted with the passphrase the user chose; the
 * passphrase is kept in the app's Keystore-backed settings so that payments run without asking. Every
 * operation runs the bundled requant-wallet (packaged as librequantwallet.so, the only place Android
 * lets an app execute a file from); the access service signs the refund and takes the states
 * (PAYMENTS.md §4.2).
 */
object ChannelWallet {
  const val FEE = 1000L // atoms: the fee of every channel state (requant-wallet CHANNEL_FEE)
  const val STEP_MINUTES = 5 // what one automatic payment buys
  const val KEEP_AHEAD = 180 // seconds of paid time below which the next payment goes out

  data class Status(val address: String, val balance: Long?)

  private fun binary(context: Context) = File(context.applicationInfo.nativeLibraryDir, "librequantwallet.so")
  private fun dir(context: Context) = File(context.filesDir, "wallet").apply { mkdirs() }
  private fun file(context: Context, name: String) = File(dir(context), name)

  /** The bundled binary exists for this device's ABI. */
  fun available(context: Context) = binary(context).canExecute()
  fun exists(context: Context) = file(context, "key.txt").isFile && Settings.walletPass(context).isNotBlank()

  /** The Requant API the wallet uses: the channels' or the swaps'. */
  private fun api(payment: PaymentInfo) = payment.channels?.api ?: payment.swaps?.requantApi ?: error("no Requant API")

  private fun run(context: Context, api: String, network: String, args: List<String>, pass: String? = null,
                  seconds: Long = 60): String {
    val command = listOf(binary(context).path) + args + listOf("--network", network, "--api", api, "--yes")
    val builder = ProcessBuilder(command).directory(dir(context))
    builder.environment()["REQUANT_WALLET_PASSPHRASE"] = pass ?: Settings.walletPass(context)
    builder.environment()["HOME"] = dir(context).path
    val process = builder.start()
    val err = StringBuilder()
    val reader = Thread { err.append(process.errorStream.bufferedReader().readText()) }.apply { start() }
    val out = process.inputStream.bufferedReader().readText()
    if (!process.waitFor(seconds, TimeUnit.SECONDS)) { process.destroy(); error("requant-wallet timed out") }
    reader.join(5000)
    if (process.exitValue() != 0) error(err.trim().lines().lastOrNull()?.removePrefix("requant-wallet: ")?.take(240) ?: "requant-wallet failed")
    return out
  }

  fun create(context: Context, passphrase: String, payment: PaymentInfo) {
    require(passphrase.length >= 8) { uiResources(context).getString(R.string.wallet_short_passphrase) }
    check(!exists(context)) { uiResources(context).getString(R.string.wallet_exists) }
    file(context, "key.txt").delete()
    run(context, api(payment), payment.network, listOf("keygen", "key.txt"), passphrase)
    check(Settings.saveWalletPass(context, passphrase)) { uiResources(context).getString(R.string.public_storage_unavailable) }
  }

  fun status(context: Context, payment: PaymentInfo): Status? {
    if (payment.channels == null && payment.swaps == null) return null
    if (!exists(context)) return null
    val field = { out: String, name: String -> out.lines().firstOrNull { it.startsWith(name) }?.trim()?.split(Regex("\\s+"))?.lastOrNull() ?: "" }
    val address = field(run(context, api(payment), payment.network, listOf("address", "key.txt")), "address")
    val balance = runCatching {
      val line = run(context, api(payment), payment.network, listOf("balance", "key.txt")).lines().first { it.startsWith("confirmed") }
      java.math.BigDecimal(line.trim().split(Regex("\\s+"))[1]).movePointRight(8).toLong()
    }.getOrNull()
    return Status(address, balance)
  }

  /** A proposal is waiting and this app has no accepted channel: opening has to be finished. */
  fun pending(context: Context) = file(context, "proposed.json").isFile && !file(context, "channel.json").isFile

  fun channel(context: Context): JSONObject? = file(context, "channel.json").takeIf { it.isFile }?.let { JSONObject(it.readText()) }

  fun exportKey(context: Context, uri: Uri) {
    context.contentResolver.openOutputStream(uri)?.use { it.write(file(context, "key.txt").readBytes()) }
      ?: error(uiResources(context).getString(R.string.public_save_failed))
  }


  /** Propose a channel to the service, store what it accepted, then send the deposit. */
  fun open(context: Context, payment: PaymentInfo, code: String, deposit: Long) {
    val strings = uiResources(context)
    val terms = payment.channels ?: error(strings.getString(R.string.wallet_no_channels))
    require(deposit >= terms.minDeposit) { strings.getString(R.string.wallet_deposit_small, Payments.formatRqt(terms.minDeposit)) }
    check(payment.channel?.status !in listOf("accepted", "open") || pending(context)) { strings.getString(R.string.wallet_channel_exists) }
    // from the service: Android lets the app itself make no plain-HTTP request to the node API
    val height = terms.height ?: error(strings.getString(R.string.public_unavailable))
    val expiry = height + minOf(terms.maxBlocks, maxOf(terms.minBlocks + terms.closeMargin + 60, 10080))
    listOf("channel.json", "state.hex").forEach { file(context, it).delete() }
    // a proposal whose answer was lost goes again as it is (the service answers with the accepted
    // channel), rather than locking other coins in a second one
    val pending = file(context, "proposed.json")
    if (!pending.isFile)
      run(context, terms.api, payment.network, listOf("channel", "open", "key.txt", terms.serverPubkey, terms.payTo,
        Payments.formatRqt(deposit), expiry.toString(), "--out", "proposed.json"))
    val proposed = JSONObject(pending.readText())
    // the service answers with its signature of the refund and where it goes (answers over some mobile
    // networks stall after their first packet); requant-wallet checks the signature before funding
    val answer = PublicAccess.post(context, "channel/open", JSONObject().put("code", code).put("channel", proposed), 60000)
    val sig2 = answer.getString("sig2")
    val at = answer.getInt("at")
    val mine = proposed.getString("refund")
    check(Regex("[0-9a-f]{128}").matches(sig2) && at >= 0 && at % 2 == 0 && at + 128 <= mine.length &&
      mine.substring(at, at + 128) == "0".repeat(128)) { strings.getString(R.string.wallet_bad_accept) }
    val accepted = JSONObject(proposed.toString()).put("refund", mine.substring(0, at) + sig2 + mine.substring(at + 128)).put("accepted", true)
    file(context, "channel.json").writeText(accepted.toString(2))
    file(context, "proposed.json").delete()
    run(context, terms.api, payment.network, listOf("channel", "fund", "key.txt", "channel.json"))
  }

  /** One step of pay-as-you-go: keep a few minutes of full access paid ahead. Returns whether it sent one. */
  fun keepPaid(context: Context, payment: PaymentInfo, code: String, nowSeconds: Long = System.currentTimeMillis() / 1000): Boolean {
    val terms = payment.channels ?: return false
    val ch = channel(context) ?: return false
    if (!ch.optBoolean("accepted") || payment.channel?.status == "closed") return false
    if (payment.paidUntil - nowSeconds > KEEP_AHEAD) return false
    val paid = ch.getLong("paid")
    val state = file(context, "state.hex")
    // the service has not taken the last state yet (the deposit still confirming): send it again
    if (paid > (payment.channel?.paid ?: 0) && state.isFile) {
      PublicAccess.post(context, "channel/pay", JSONObject().put("code", code).put("state", state.readText().trim()), 60000)
      return true
    }
    val most = ch.getLong("deposit") - FEE
    if (paid >= most) return false
    val total = minOf(most, paid + STEP_MINUTES * terms.pricePerMinute)
    run(context, terms.api, payment.network, listOf("channel", "pay", "key.txt", "channel.json", Payments.formatRqt(total), "--out", "state.hex"))
    PublicAccess.post(context, "channel/pay", JSONObject().put("code", code).put("state", state.readText().trim()), 60000)
    return true
  }

  /** From the VPN service: pay ahead when there is a channel; quiet otherwise. */
  fun payAhead(context: Context): Boolean {
    if (!PublicAccess.enabled(context) || !available(context) || !exists(context) || channel(context) == null) return false
    val payment = PublicAccess.payment(context) ?: return false
    return keepPaid(context, payment, Settings.publicCode(context))
  }

  fun close(context: Context) { PublicAccess.post(context, "channel/close", JSONObject().put("code", Settings.publicCode(context)), 60000) }

  // ---- buying RQT from the service's maker (atomic swaps: Lightning, on-chain Bitcoin or USDT on TRON) --
  data class Swap(val file: String, val method: String, val rqtAtoms: Long, val sats: Long, val state: String,
                  val invoice: String?, val address: String?, val usdtUnits: Long = 0, val held: String? = null,
                  val lock: String? = null, val refundFrom: Long = 0, val note: String? = null)

  /** USDT swap file -> the error of its last lock ("" while one runs). */
  private val locking = java.util.concurrent.ConcurrentHashMap<String, String>()

  private fun swapIndex(context: Context): org.json.JSONArray =
    file(context, "swaps.json").takeIf { it.isFile }?.let { org.json.JSONArray(it.readText()) } ?: org.json.JSONArray()

  private fun saveSwaps(context: Context, list: org.json.JSONArray) {
    val keep = org.json.JSONArray()
    for (k in maxOf(0, list.length() - 20) until list.length()) keep.put(list.get(k))
    file(context, "swaps.json").writeText(keep.toString(2))
  }

  private fun swapOf(o: JSONObject) = Swap(o.getString("file"), o.getString("method"), o.getLong("rqtAtoms"), o.optLong("sats"),
    o.getString("state"), o.optString("invoice").ifBlank { null }, o.optString("address").ifBlank { null }, o.optLong("usdtUnits"),
    o.optString("held").ifBlank { null }, o.optString("lock").ifBlank { null }, o.optLong("refundFrom"),
    o.optString("note").ifBlank { null })

  fun swaps(context: Context): List<Swap> = swapIndex(context).let { a -> (0 until a.length()).map { swapOf(a.getJSONObject(it)) } }

  private val FINAL = setOf("done", "claimed", "failed", "refunded")
  // final for Lightning and Bitcoin; a USDT purchase is followed until its USDT is back
  private fun finished(method: String, state: String) =
    state in FINAL || (method != "usdt" && state in setOf("expired", "rqt_refunded"))

  /** Start a purchase; the swap file (it holds the secret) stays in the wallet directory. */
  fun buy(context: Context, payment: PaymentInfo, method: String, atoms: Long): Swap {
    val strings = uiResources(context)
    val s = payment.swaps ?: error(strings.getString(R.string.swap_unavailable))
    check(method in s.methods && (method != "lightning" || s.lightning) && (method != "usdt" || s.usdt != null)) {
      strings.getString(R.string.swap_unavailable)
    }
    require(atoms in s.minAtoms..s.maxAtoms) { strings.getString(R.string.swap_bad_amount, Payments.formatRqt(s.minAtoms), Payments.formatRqt(s.maxAtoms)) }
    File(dir(context), "swaps").mkdirs()
    val name = "swaps/" + System.currentTimeMillis() + ".json"
    val command = when (method) { "lightning" -> "buy-ln"; "usdt" -> "buy-usdt"; else -> "buy" }
    val out = run(context, s.requantApi, payment.network, listOf("swap", command, s.maker,
      Payments.formatRqt(atoms), "key.txt", "--out", name))
    val line = { key: String -> out.lines().firstOrNull { it.startsWith(key) }?.removePrefix(key)?.trim() }
    val record = JSONObject(file(context, name).readText())
    val entry = JSONObject().put("file", name).put("method", method).put("rqtAtoms", atoms).put("sats", record.optLong("btc_sats"))
      .put("state", "waiting").put("created", System.currentTimeMillis())
    when (method) {
      "lightning" -> entry.put("invoice", line("invoice"))
      "usdt" -> entry.put("address", record.getJSONObject("terms").getString("sender")).put("usdtUnits", record.getLong("units"))
      else -> entry.put("address", line("to"))
    }
    saveSwaps(context, swapIndex(context).put(entry))
    return swapOf(entry)
  }

  /** Follow the open purchases: lock USDT once it has arrived (on a thread of its own: TRON takes a minute or
   *  two), and claim the RQT as soon as the maker has locked them. */
  fun advance(context: Context, payment: PaymentInfo): List<Swap> {
    val s = payment.swaps ?: return swaps(context)
    val list = swapIndex(context)
    for (k in 0 until list.length()) {
      val e = list.getJSONObject(k)
      if (finished(e.getString("method"), e.getString("state"))) continue
      runCatching {
        val file = e.getString("file")
        val st = JSONObject(run(context, s.requantApi, payment.network, listOf("swap", "status", file)))
        val state = st.getString("state")
        e.put("state", if (state == "btc_claimed" || state == "token_claimed") "claimed" else state)
        if (e.getString("method") == "usdt") {
          e.put("held", st.optString("usdt_held")).put("lock", st.optString("lock")).put("refundFrom", st.optLong("refund_from"))
          e.put("note", locking[file] ?: "")
          val arrived = (st.optString("usdt_held").toDoubleOrNull() ?: 0.0) >= (st.optString("usdt_to_lock").toDoubleOrNull() ?: 1e18)
          if (state == "waiting_token" && st.optString("lock") == "none" && arrived) {
            if (locking[file] == "") e.put("state", "locking")
            else {
              locking[file] = ""
              Thread {
                runCatching { run(context, s.requantApi, payment.network, listOf("swap", "lock", file), seconds = 300) }
                  .onSuccess { locking.remove(file) }
                  .onFailure { locking[file] = it.message?.take(160) ?: "lock failed" }
              }.start()
              e.put("state", "locking")
            }
          }
        }
        if (state == "rqt_locked") {
          run(context, s.requantApi, payment.network, listOf("swap", "claim", e.getString("file"), "key.txt"))
          e.put("state", "claimed")
        }
      }
    }
    saveSwaps(context, list)
    return swaps(context)
  }

  fun hasOpenSwaps(context: Context) = swaps(context).any { !finished(it.method, it.state) }

  /** Taking back what a purchase the maker did not complete paid: BTC through the Esplora API, or USDT on TRON
   *  (a lock still open back to the swap's address first, then to `address`). */
  fun refundSwap(context: Context, payment: PaymentInfo, file: String, address: String): String {
    val s = payment.swaps ?: error(uiResources(context).getString(R.string.swap_unavailable))
    if (swaps(context).firstOrNull { it.file == file }?.method == "usdt") {
      require(Regex("T[1-9A-HJ-NP-Za-km-z]{33}").matches(address)) { uiResources(context).getString(R.string.swap_bad_tron_address) }
      val st = JSONObject(run(context, s.requantApi, payment.network, listOf("swap", "status", file)))
      if (st.optString("lock") == "open") run(context, s.requantApi, payment.network, listOf("swap", "refund", file), seconds = 300)
      val out = run(context, s.requantApi, payment.network, listOf("swap", "withdraw", file, address), seconds = 300)
      val list = swapIndex(context)
      for (k in 0 until list.length()) list.getJSONObject(k).let { if (it.getString("file") == file) it.put("state", "refunded").put("note", "") }
      saveSwaps(context, list)
      return out.trim()
    }
    val btcAddress = address
    require(Regex("[a-zA-Z0-9]{14,90}").matches(btcAddress)) { uiResources(context).getString(R.string.swap_bad_address) }
    val hex = run(context, s.requantApi, payment.network, listOf("swap", "refund", file, btcAddress)).trim()
    val connection = java.net.URL(s.bitcoinApi + "/tx").openConnection() as javax.net.ssl.HttpsURLConnection
    connection.requestMethod = "POST"
    connection.doOutput = true
    connection.setRequestProperty("Connection", "close")
    connection.connectTimeout = 15000
    connection.readTimeout = 30000
    val body = hex.toByteArray()
    connection.setFixedLengthStreamingMode(body.size)
    try {
      connection.outputStream.use { it.write(body) }
      val ok = connection.responseCode == 200
      val text = (if (ok) connection.inputStream else connection.errorStream)?.bufferedReader()?.readText().orEmpty()
      check(ok) { text.take(200) }
      val list = swapIndex(context)
      for (k in 0 until list.length()) list.getJSONObject(k).let { if (it.getString("file") == file) it.put("state", "refunded") }
      saveSwaps(context, list)
      return text.trim()
    } finally { connection.disconnect() }
  }

  /** From the VPN service and the panel: move purchases on; quiet without any. */
  fun advanceSwaps(context: Context) {
    if (!PublicAccess.enabled(context) || !available(context) || !exists(context) || !hasOpenSwaps(context)) return
    val payment = PublicAccess.payment(context) ?: return
    advance(context, payment)
  }

  fun refund(context: Context, payment: PaymentInfo) {
    val terms = payment.channels ?: error(uiResources(context).getString(R.string.wallet_no_channels))
    run(context, terms.api, payment.network, listOf("channel", "refund", "channel.json"))
  }
}
