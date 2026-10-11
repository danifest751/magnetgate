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

  private fun run(context: Context, terms: ChannelTerms, network: String, args: List<String>, pass: String? = null): String {
    val command = listOf(binary(context).path) + args + listOf("--network", network, "--api", terms.api, "--yes")
    val builder = ProcessBuilder(command).directory(dir(context))
    builder.environment()["REQUANT_WALLET_PASSPHRASE"] = pass ?: Settings.walletPass(context)
    builder.environment()["HOME"] = dir(context).path
    val process = builder.start()
    val err = StringBuilder()
    val reader = Thread { err.append(process.errorStream.bufferedReader().readText()) }.apply { start() }
    val out = process.inputStream.bufferedReader().readText()
    if (!process.waitFor(60, TimeUnit.SECONDS)) { process.destroy(); error("requant-wallet timed out") }
    reader.join(5000)
    if (process.exitValue() != 0) error(err.trim().lines().lastOrNull()?.removePrefix("requant-wallet: ")?.take(240) ?: "requant-wallet failed")
    return out
  }

  fun create(context: Context, passphrase: String, payment: PaymentInfo) {
    val terms = payment.channels ?: error(uiResources(context).getString(R.string.wallet_no_channels))
    require(passphrase.length >= 8) { uiResources(context).getString(R.string.wallet_short_passphrase) }
    check(!exists(context)) { uiResources(context).getString(R.string.wallet_exists) }
    file(context, "key.txt").delete()
    run(context, terms, payment.network, listOf("keygen", "key.txt"), passphrase)
    check(Settings.saveWalletPass(context, passphrase)) { uiResources(context).getString(R.string.public_storage_unavailable) }
  }

  fun status(context: Context, payment: PaymentInfo): Status? {
    val terms = payment.channels ?: return null
    if (!exists(context)) return null
    val field = { out: String, name: String -> out.lines().firstOrNull { it.startsWith(name) }?.trim()?.split(Regex("\\s+"))?.lastOrNull() ?: "" }
    val address = field(run(context, terms, payment.network, listOf("address", "key.txt")), "address")
    val balance = runCatching {
      val line = run(context, terms, payment.network, listOf("balance", "key.txt")).lines().first { it.startsWith("confirmed") }
      java.math.BigDecimal(line.trim().split(Regex("\\s+"))[1]).movePointRight(8).toLong()
    }.getOrNull()
    return Status(address, balance)
  }

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
    check(payment.channel?.status !in listOf("accepted", "open")) { strings.getString(R.string.wallet_channel_exists) }
    // from the service: Android lets the app itself make no plain-HTTP request to the node API
    val height = terms.height ?: error(strings.getString(R.string.public_unavailable))
    val expiry = height + minOf(terms.maxBlocks, maxOf(terms.minBlocks + terms.closeMargin + 60, 10080))
    listOf("channel.json", "state.hex").forEach { file(context, it).delete() }
    run(context, terms, payment.network, listOf("channel", "open", "key.txt", terms.serverPubkey, terms.payTo,
      Payments.formatRqt(deposit), expiry.toString(), "--out", "proposed.json"))
    val proposed = JSONObject(file(context, "proposed.json").readText())
    val accepted = PublicAccess.post(context, "channel/open", JSONObject().put("code", code).put("channel", proposed)).getJSONObject("channel")
    // the service's copy must be this channel with the refund signed
    check(accepted.getString("funding_txid") == proposed.getString("funding_txid") && accepted.optBoolean("accepted") &&
      accepted.getString("refund") != proposed.getString("refund")) { strings.getString(R.string.wallet_bad_accept) }
    file(context, "channel.json").writeText(accepted.toString(2))
    file(context, "proposed.json").delete()
    run(context, terms, payment.network, listOf("channel", "fund", "key.txt", "channel.json"))
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
      PublicAccess.post(context, "channel/pay", JSONObject().put("code", code).put("state", state.readText().trim()))
      return true
    }
    val most = ch.getLong("deposit") - FEE
    if (paid >= most) return false
    val total = minOf(most, paid + STEP_MINUTES * terms.pricePerMinute)
    run(context, terms, payment.network, listOf("channel", "pay", "key.txt", "channel.json", Payments.formatRqt(total), "--out", "state.hex"))
    PublicAccess.post(context, "channel/pay", JSONObject().put("code", code).put("state", state.readText().trim()))
    return true
  }

  /** From the VPN service: pay ahead when there is a channel; quiet otherwise. */
  fun payAhead(context: Context): Boolean {
    if (!PublicAccess.enabled(context) || !available(context) || !exists(context) || channel(context) == null) return false
    val payment = PublicAccess.payment(context) ?: return false
    return keepPaid(context, payment, Settings.publicCode(context))
  }

  fun close(context: Context) { PublicAccess.post(context, "channel/close", JSONObject().put("code", Settings.publicCode(context))) }

  fun refund(context: Context, payment: PaymentInfo) {
    val terms = payment.channels ?: error(uiResources(context).getString(R.string.wallet_no_channels))
    run(context, terms, payment.network, listOf("channel", "refund", "channel.json"))
  }
}
