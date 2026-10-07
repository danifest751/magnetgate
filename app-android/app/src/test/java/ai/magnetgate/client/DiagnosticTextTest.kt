package ai.magnetgate.client

import org.junit.Assert.assertEquals
import org.junit.Test

class DiagnosticTextTest {
  @Test fun hidesAddressesButPreservesTimesAndHostnames() {
    assertEquals("19:53:48 dial [адрес скрыт]:4443", diagnosticText("19:53:48 dial 203.0.113.2:4443"))
    assertEquals("dial [[адрес скрыт]]:443 / [адрес скрыт]", diagnosticText("dial [2001:db8::1]:443 / ::1"))
    assertEquals("https://example.com at 20:06:01", diagnosticText("https://example.com at 20:06:01"))
  }
}
