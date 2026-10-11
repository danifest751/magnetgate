package ai.magnetgate.client

import org.json.JSONObject

/** One price line: [days] of full access for [atoms] (10^8 per RQT), [off] percent discount. */
data class PriceStep(val days: Int, val atoms: Long, val off: Int)

/** The service's terms for payment channels (PAYMENTS.md §4.2). */
data class ChannelTerms(
  val api: String, val serverPubkey: String, val payTo: String, val minDeposit: Long, val minBlocks: Int,
  val maxBlocks: Int, val closeMargin: Int, val pricePerMinute: Long,
  /** The chain height the service sees (the app needs no plain-HTTP request of its own). */
  val height: Int? = null,
)

/** Where the app buys RQT: the service's maker, its price and limits (atoms), and the APIs it needs. */
data class SwapTerms(
  val maker: String, val methods: List<String>, val bitcoinApi: String, val requantApi: String, val satsPerRqt: Long,
  val minAtoms: Long, val maxAtoms: Long, val lightning: Boolean, val usdt: UsdtTerms? = null,
)

/** USDT on TRON at the maker: millionths of a USDT per RQT; the maker pays the TRON fees when paysFees. */
data class UsdtTerms(val unitsPerRqt: Long, val network: String, val paysFees: Boolean)

/** The service's view of the account's latest channel. */
data class ChannelState(val status: String, val deposit: Long, val paid: Long)

/** What the access service says about the account's payments (POST /api/payment). */
data class PaymentInfo(
  val network: String, val address: String, val full: Boolean, val paidUntil: Long, val expires: Long,
  val balance: Long, val price: Long, val discounts: List<Pair<Int, Int>>, val confirmations: Int,
  val channels: ChannelTerms? = null, val channel: ChannelState? = null, val swaps: SwapTerms? = null,
) {
  fun cost(days: Int): PriceStep {
    val off = discounts.filter { days >= it.first }.maxOfOrNull { it.second } ?: 0
    return PriceStep(days, (price * days * (100 - off) + 99) / 100, off)
  }
  /** One day and each discount step. */
  fun steps(): List<PriceStep> = (listOf(1) + discounts.map { it.first }).distinct().sorted().map(::cost)
  fun fullNow(nowSeconds: Long = System.currentTimeMillis() / 1000) = full && paidUntil > nowSeconds
}

object Payments {
  private val ADDRESS = Regex("(trq|rqrt|rq)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,80}")

  /** Checked before anything is shown; throws on anything unexpected. */
  fun parse(json: JSONObject): PaymentInfo {
    fun atoms(key: String) = json.getLong(key).also { require(it >= 0) }
    require(json.getString("currency") == "RQT")
    val network = json.getString("network").also { require(it in listOf("test", "regtest", "main")) }
    val address = json.getString("address").also { require(ADDRESS.matches(it)) }
    val tier = json.getString("tier").also { require(it in listOf("free", "full")) }
    val price = atoms("priceAtomsPerDay").also { require(it > 0) }
    val list = json.getJSONArray("discounts")
    require(list.length() <= 10)
    val discounts = (0 until list.length()).map {
      val step = list.getJSONArray(it)
      require(step.length() == 2)
      Pair(step.getInt(0), step.getInt(1)).also { d -> require(d.first > 0 && d.second in 0..99) }
    }
    val confirmations = json.getInt("confirmations").also { require(it in 1..1000) }
    return PaymentInfo(network, address, tier == "full", atoms("paidUntil"), atoms("expires"), atoms("balanceAtoms"),
      price, discounts, confirmations, json.optJSONObject("channels")?.let(::terms), json.optJSONObject("channel")?.let(::state),
      json.optJSONObject("swaps")?.let { runCatching { swapTerms(it) }.getOrNull() })
  }

  private fun terms(c: JSONObject): ChannelTerms {
    val api = c.getString("api").trimEnd('/').also { require(Regex("https?://[A-Za-z0-9.:\\[\\]-]{1,100}").matches(it)) }
    val pubkey = c.getString("serverPubkey").also { require(Regex("[a-f0-9]{64}").matches(it)) }
    val payTo = c.getString("payTo").also { require(ADDRESS.matches(it)) }
    return ChannelTerms(api, pubkey, payTo, c.getLong("minDepositAtoms").also { require(it > 0) }, c.getInt("minBlocks"),
      c.getInt("maxBlocks"), c.getInt("closeMarginBlocks"), c.getLong("priceAtomsPerMinute").also { require(it > 0) },
      if (c.has("height") && !c.isNull("height")) c.getInt("height").also { require(it >= 0) } else null)
  }

  private fun swapTerms(c: JSONObject): SwapTerms {
    val maker = c.getString("maker").also { require(Regex("[A-Za-z0-9.-]{1,80}:[0-9]{1,5}").matches(it)) }
    val list = c.getJSONArray("methods")
    val methods = (0 until list.length()).map { list.getString(it) }.filter { it in listOf("lightning", "bitcoin", "usdt") }
    val bitcoinApi = c.getString("bitcoinApi").also { require(it.startsWith("https://") && it.length < 120) }
    val requantApi = c.getString("requantApi").trimEnd('/').also { require(Regex("https?://[A-Za-z0-9.:\\[\\]-]{1,100}").matches(it)) }
    return SwapTerms(maker, methods, bitcoinApi, requantApi, c.getLong("satsPerRqt").also { require(it > 0) },
      c.getLong("minAtoms"), c.getLong("maxAtoms"), c.optBoolean("lightning"),
      c.optJSONObject("usdt")?.let { u ->
        runCatching {
          UsdtTerms(u.getLong("unitsPerRqt").also { require(it > 0) }, u.getString("network").also { require(Regex("[a-z]{2,16}").matches(it)) },
            u.optBoolean("paysFees"))
        }.getOrNull()
      })
  }

  private fun state(c: JSONObject) = ChannelState(c.getString("status").also { require(it.length <= 20) },
    c.getLong("depositAtoms"), c.getLong("paidAtoms"))

  /** RQT typed by the user to atoms, or null (at most 8 decimals). */
  fun parseRqt(text: String): Long? {
    val m = Regex("\\s*(\\d{1,8})(?:[.,](\\d{1,8}))?\\s*").matchEntire(text) ?: return null
    return m.groupValues[1].toLong() * 100_000_000 + m.groupValues[2].padEnd(8, '0').toLong()
  }

  /** RQT from atoms, without trailing zeros. */
  fun formatRqt(atoms: Long): String {
    val part = (atoms % 100_000_000).toString().padStart(8, '0').trimEnd('0')
    return if (part.isEmpty()) (atoms / 100_000_000).toString() else "${atoms / 100_000_000}.$part"
  }
}
