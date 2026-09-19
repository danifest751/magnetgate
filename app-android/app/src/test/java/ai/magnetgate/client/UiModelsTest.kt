package ai.magnetgate.client

import org.junit.Assert.*
import org.junit.Test

class UiModelsTest {
  private val ui = TestStrings.load("ru")
  private val now = 1_000_000L
  private val ready = CoreStatus(running = true, nodes = listOf(NodeRow(0, "test", "test", "NL", emptyList(), emptyList())))
  private val ok = Health.Check(now - 20_000, true, 630, "example", Health.Legs(200, 300, 130, 84))

  @Test fun `запущенный VPN без проверки не получает зелёный статус`() {
    assertEquals(ConnectionTone.WARN, connectionPresentation(ready, true, false, true, null, "", now, ui).tone)
  }

  @Test fun `свежая успешная проверка подтверждает соединение`() {
    assertEquals(ConnectionTone.OK, connectionPresentation(ready, true, false, true, ok, "", now, ui).tone)
  }

  @Test fun `устаревший успех не выдаётся за текущее подтверждение`() {
    assertEquals(ConnectionTone.WARN, connectionPresentation(ready, true, false, true, ok.copy(atMs = now - 151_000), "", now, ui).tone)
  }

  @Test fun `неудачный запрос и ошибка ядра имеют приоритет над успехом`() {
    assertEquals(ConnectionTone.BAD, connectionPresentation(ready, true, false, true, ok.copy(ok = false), "", now, ui).tone)
    assertEquals(ConnectionTone.BAD, connectionPresentation(ready, true, false, true, ok, "engine failed", now, ui).tone)
  }

  @Test fun `старый успех не показывает подключение после отключения`() {
    assertEquals(ConnectionTone.OFF, connectionPresentation(ready, false, false, true, ok, "", now, ui).tone)
  }

  @Test fun `подключение и медленный ответ имеют собственные состояния`() {
    assertEquals("Подключаемся", connectionPresentation(ready, false, true, true, ok, "", now, ui).title)
    assertEquals(ConnectionTone.WARN, connectionPresentation(ready, true, false, true, ok.copy(tookMs = Health.SLOW_MS), "", now, ui).tone)
  }

  @Test fun `молчащий релей не отменяет успешную проверку трафика`() {
    val status = ready.copy(relays = listOf(RelayRow("wss://example.org", true, false, "")))
    assertEquals(ConnectionTone.OK, connectionPresentation(status, true, false, true, ok, "", now, ui).tone)
  }

  @Test fun `нет ключа ведёт к настройке доступа`() {
    assertEquals("Добавьте доступ", connectionPresentation(CoreStatus(), false, false, false, null, "", now, ui).title)
  }

  @Test fun `редактор доменов нормализует ввод и отклоняет URL`() {
    assertEquals("example.org", normalizeDomain("  *.EXAMPLE.org. "))
    listOf("https://example.org", "example.org/path", "bad domain.org", "-host.org", "host-.org", "a..org", "", "a".repeat(64) + ".org").forEach {
      assertNull(it, normalizeDomain(it))
    }
  }
}
