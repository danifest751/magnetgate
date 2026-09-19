package ai.magnetgate.client

import java.io.File
import java.util.Locale
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.*
import org.junit.Test

/** Читаем настоящие каталоги переводов, чтобы тесты ловили пропуски и ошибки шаблонов. */
internal object TestStrings {
  fun catalog(language: String): Map<String, String> {
    val folder = if (language == "ru") "values-ru" else "values"
    val document = DocumentBuilderFactory.newInstance().newDocumentBuilder()
      .parse(File("src/main/res/$folder/strings.xml"))
    val nodes = document.getElementsByTagName("string")
    return (0 until nodes.length).associate { index ->
      val node = nodes.item(index)
      node.attributes.getNamedItem("name").nodeValue to node.textContent.replace("\\'", "'").replace("\\n", "\n")
    }
  }

  fun load(language: String): UiStrings {
    val catalog = catalog(language)
    val byId = catalog.mapKeys { (name, _) -> R.string::class.java.getField(name).getInt(null) }
    val locale = Locale.forLanguageTag(language)
    return UiStrings(locale) { id, args -> String.format(locale, byId.getValue(id), *args) }
  }
}

class UiLanguageTest {
  @Test fun `явный выбор имеет приоритет над языком устройства`() {
    assertEquals(UiLanguage.EN, UiLanguage.resolve("en", "ru"))
    assertEquals(UiLanguage.RU, UiLanguage.resolve("ru", "en"))
    assertEquals(UiLanguage.RU, UiLanguage.resolve(null, "ru"))
    assertEquals(UiLanguage.EN, UiLanguage.resolve(null, "de"))
    assertEquals(UiLanguage.RU, UiLanguage.resolve("invalid", "ru"))
  }

  @Test fun `обе локали имеют полный набор одинаковых шаблонов`() {
    val en = TestStrings.catalog("en") - "app_name"
    val ru = TestStrings.catalog("ru")
    assertEquals(en.keys, ru.keys)
    val placeholders = Regex("%([1-9][0-9]*)\\$[.0-9]*([sdf])")
    en.forEach { (key, english) ->
      val russian = ru.getValue(key)
      assertTrue(key, english.isNotBlank() && russian.isNotBlank())
      assertEquals(key, placeholders.findAll(english).map { it.groupValues[1] to it.groupValues[2] }.toList(),
        placeholders.findAll(russian).map { it.groupValues[1] to it.groupValues[2] }.toList())
      assertFalse(key, Regex("[А-Яа-яЁё]").containsMatchIn(english) && key != "language_ru")
    }
  }

  @Test fun `измерения страны и сообщения используют выбранную локаль`() {
    val ru = TestStrings.load("ru")
    val en = TestStrings.load("en")
    assertEquals("Нидерланды", ru.countryName("NL"))
    assertEquals("Netherlands", en.countryName("NL"))
    assertEquals("Автоматически", ru.countryName(""))
    assertEquals("Automatic", en.countryName(""))
    assertEquals("1,5 КБ", ru.bytes(1536))
    assertEquals("1.5 KB", en.bytes(1536))
    assertEquals("1,5 с", ru.durationOf(1500))
    assertEquals("1.5 s", en.durationOf(1500))
    assertEquals("206 ms", en.durationOf(206))
    assertEquals("Enter a valid domain name", en.text(R.string.domain_invalid))
    assertEquals("Selected: 3", en.text(R.string.selected_count, 3))
    assertEquals("VPN is off", connectionPresentation(CoreStatus(), false, false, true, null, "", 0, en).title)
  }
}
