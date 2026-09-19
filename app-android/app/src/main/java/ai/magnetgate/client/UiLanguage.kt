package ai.magnetgate.client

import android.content.Context
import android.content.res.Configuration
import androidx.annotation.StringRes
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import java.util.Locale

enum class UiLanguage(val tag: String) {
  RU("ru"), EN("en");

  companion object {
    fun resolve(saved: String?, systemLanguage: String): UiLanguage =
      entries.firstOrNull { it.tag == saved }
        ?: if (systemLanguage == "ru") RU else EN
  }
}

/** Строки Android с явной локалью; язык интерфейса не меняет настройки туннеля. */
class UiStrings(val locale: Locale, private val resolve: (Int, Array<out Any>) -> String) {
  fun text(@StringRes id: Int, vararg args: Any): String = resolve(id, args)
  fun optional(@StringRes id: Int): String = if (id == 0) "" else text(id)
}

data class LanguageSelection(val language: UiLanguage, val select: (UiLanguage) -> Unit)

val LocalUiStrings = staticCompositionLocalOf<UiStrings> { error("UiLanguageProvider is required") }
val LocalUiLanguage = staticCompositionLocalOf<LanguageSelection> { error("UiLanguageProvider is required") }

@Composable
fun UiLanguageProvider(content: @Composable () -> Unit) {
  val context = LocalContext.current
  val configuration = LocalConfiguration.current
  val preferences = remember(context) { context.getSharedPreferences("magnetgate-ui", Context.MODE_PRIVATE) }
  var saved by remember { mutableStateOf(preferences.getString("language", null)) }
  val language = UiLanguage.resolve(saved, configuration.locales[0].language)
  val strings = remember(language, configuration) {
    val locale = Locale.forLanguageTag(language.tag)
    val localized = context.createConfigurationContext(Configuration(configuration).apply { setLocale(locale) })
    UiStrings(locale) { id, args -> localized.resources.getString(id, *args) }
  }
  val selection = LanguageSelection(language) { next ->
    preferences.edit().putString("language", next.tag).apply()
    saved = next.tag
  }
  // Не пересоздаём Activity: черновики, ввод ключа и работающий VPN сохраняются.
  CompositionLocalProvider(LocalUiStrings provides strings, LocalUiLanguage provides selection, content = content)
}
