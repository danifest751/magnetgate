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

  @Test fun rqtAmounts() {
    assertEquals("1.5", Payments.formatRqt(150_000_000))
    assertEquals("0.07", Payments.formatRqt(7_000_000))
    assertEquals("2", Payments.formatRqt(200_000_000))
  }
}
