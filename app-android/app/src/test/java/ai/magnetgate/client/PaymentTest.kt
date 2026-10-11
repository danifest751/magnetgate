package ai.magnetgate.client

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PaymentTest {
  private fun answer() = JSONObject()
    .put("currency", "RQT").put("network", "test").put("priceAtomsPerDay", 10_000_000L)
    .put("discounts", JSONArray().put(JSONArray().put(7).put(10)).put(JSONArray().put(30).put(20)).put(JSONArray().put(90).put(30)))
    .put("confirmations", 6).put("address", "trq1q64k873ph3ngupg63e70cv5e276nk43ry23742j8clmm6m5wsn99qnqa0ak")
    .put("tier", "free").put("paidUntil", 0).put("expires", 1_900_000_000L).put("balanceAtoms", 0).put("credits", JSONArray())

  @Test fun pricesFollowTheDiscountSteps() {
    val info = Payments.parse(answer())
    assertEquals(listOf(PriceStep(1, 10_000_000, 0), PriceStep(7, 63_000_000, 10), PriceStep(30, 240_000_000, 20), PriceStep(90, 630_000_000, 30)), info.steps())
    assertFalse(info.fullNow(1_000))
    assertTrue(Payments.parse(answer().put("tier", "full").put("paidUntil", 2_000)).fullNow(1_000))
  }

  @Test fun unexpectedAnswersAreRefused() {
    val bad = listOf(
      answer().put("address", "bc1qxyz"), answer().put("tier", "gold"), answer().put("currency", "BTC"),
      answer().put("priceAtomsPerDay", 0), answer().put("balanceAtoms", -1), answer().put("confirmations", 0),
      answer().put("discounts", JSONArray().put(JSONArray().put(7).put(100))),
    )
    for (json in bad) assertTrue(json.toString(), runCatching { Payments.parse(json) }.isFailure)
  }

  private fun swaps() = JSONObject().put("maker", "maker.example:19390")
    .put("methods", JSONArray().put("lightning").put("bitcoin").put("usdt").put("card"))
    .put("bitcoinApi", "https://mempool.space/signet/api").put("requantApi", "http://node.example:19380")
    .put("satsPerRqt", 1000).put("minAtoms", 10_000_000L).put("maxAtoms", 10_000_000_000L).put("lightning", true)

  @Test fun usdtTermsComeWithTheMakersTronSide() {
    val usdt = JSONObject().put("unitsPerRqt", 100_000).put("network", "nile").put("paysFees", true)
    val s = Payments.parse(answer().put("swaps", swaps().put("usdt", usdt))).swaps!!
    assertEquals(listOf("lightning", "bitcoin", "usdt"), s.methods)
    assertEquals(UsdtTerms(100_000, "nile", true), s.usdt)
    assertEquals(null, Payments.parse(answer().put("swaps", swaps())).swaps!!.usdt)
    // a malformed USDT block hides USDT only, not the other ways to pay
    val bad = Payments.parse(answer().put("swaps", swaps().put("usdt", JSONObject().put("unitsPerRqt", 0).put("network", "nile")))).swaps!!
    assertEquals(null, bad.usdt)
    assertTrue(bad.lightning)
  }

  @Test fun rqtAmounts() {
    assertEquals("1.5", Payments.formatRqt(150_000_000))
    assertEquals("0.07", Payments.formatRqt(7_000_000))
    assertEquals("2", Payments.formatRqt(200_000_000))
  }
}
