package ai.magnetgate.client

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * How the app looks, and why it looks that way.
 *
 * This is an instrument before it is an app: its whole promise is to say what is true about a tunnel -
 * which exit carries traffic, how long that exit took to answer, which plane is sitting out and for how
 * long. So the design follows the instrument: a quiet slate ground, one warm accent spent only on the
 * thing the person came to press, and colour reserved for state rather than decoration. Material's own
 * default palette (the purple) is what every unstyled app wears; it says nothing about this one.
 *
 * Measured values are set in a monospace face - addresses, milliseconds, ports, generations, log lines.
 * They line up in columns, they never reflow between readings, and the difference between a number and a
 * sentence is visible before either is read. Both faces are the platform's own: an app that must start
 * on a phone with no working network cannot wait on a font download.
 */

/** Colours that mean a state rather than a brand; kept apart from the accent on purpose. */
data class StateColors(
  /** Working, measured, recent. */
  val ok: Color,
  /** Working, but not well enough to trust silently - a slow exit, a demoted plane. */
  val warn: Color,
  /** Not working: a failed check, a paused plane, an engine that refused. */
  val bad: Color,
  /** The ground for a state band, tinted by the state it carries. */
  val okSurface: Color,
  val warnSurface: Color,
  val badSurface: Color,
  /** Hairlines and the rails down the side of a row. */
  val rule: Color,
)

val LocalStateColors = staticCompositionLocalOf {
  StateColors(
    ok = Color(0xFF2F9E6E),
    warn = Color(0xFFD9891F),
    bad = Color(0xFFCF4A3E),
    okSurface = Color(0xFFE6F3EC),
    warnSurface = Color(0xFFFBF0DF),
    badSurface = Color(0xFFFAE9E7),
    rule = Color(0xFFC9D2D8),
  )
}

private val LightState = StateColors(
  ok = Color(0xFF1E7D55),
  warn = Color(0xFFA9660B),
  bad = Color(0xFFB03A2F),
  okSurface = Color(0xFFE4F1EA),
  warnSurface = Color(0xFFF9EEDC),
  badSurface = Color(0xFFF8E7E4),
  rule = Color(0xFFCCD5DB),
)

private val DarkState = StateColors(
  ok = Color(0xFF4FC793),
  warn = Color(0xFFE8A64F),
  bad = Color(0xFFE4695C),
  okSurface = Color(0xFF12241D),
  warnSurface = Color(0xFF261C0E),
  badSurface = Color(0xFF2A1512),
  rule = Color(0xFF2B363F),
)

// The neutrals carry a slight blue bias rather than being pure grey: it is the colour of the instrument
// this app pretends to be, and it keeps the amber accent from reading as dirt on the screen.
private val LightScheme = lightColorScheme(
  primary = Color(0xFF98600E),
  onPrimary = Color(0xFFFFFFFF),
  primaryContainer = Color(0xFFF7E7CC),
  onPrimaryContainer = Color(0xFF3A2405),
  secondary = Color(0xFF41535F),
  onSecondary = Color(0xFFFFFFFF),
  secondaryContainer = Color(0xFFE2E9EE),
  onSecondaryContainer = Color(0xFF17232B),
  background = Color(0xFFF3F6F7),
  onBackground = Color(0xFF0F171C),
  surface = Color(0xFFFFFFFF),
  onSurface = Color(0xFF0F171C),
  surfaceVariant = Color(0xFFE7ECEF),
  onSurfaceVariant = Color(0xFF47555F),
  outline = Color(0xFFB6C2CA),
  outlineVariant = Color(0xFFD7DFE4),
  error = Color(0xFFB03A2F),
  onError = Color(0xFFFFFFFF),
)

private val DarkScheme = darkColorScheme(
  primary = Color(0xFFE8A64F),
  onPrimary = Color(0xFF1A1206),
  primaryContainer = Color(0xFF3A2A11),
  onPrimaryContainer = Color(0xFFF7DDB4),
  secondary = Color(0xFFA8BAC6),
  onSecondary = Color(0xFF12202A),
  secondaryContainer = Color(0xFF223039),
  onSecondaryContainer = Color(0xFFDCE6ED),
  background = Color(0xFF0E1418),
  onBackground = Color(0xFFE7EEF3),
  surface = Color(0xFF141C22),
  onSurface = Color(0xFFE7EEF3),
  surfaceVariant = Color(0xFF1D262D),
  onSurfaceVariant = Color(0xFF9BAAB5),
  outline = Color(0xFF3A4751),
  outlineVariant = Color(0xFF2A343C),
  error = Color(0xFFE4695C),
  onError = Color(0xFF2A0F0C),
)

/** The face every measured value is set in. */
val Mono = FontFamily.Monospace

private val Sans = FontFamily.SansSerif

private val MgTypography = Typography(
  headlineSmall = TextStyle(
    fontFamily = Sans,
    fontWeight = FontWeight.SemiBold,
    fontSize = 26.sp,
    lineHeight = 30.sp,
    letterSpacing = (-0.4).sp,
  ),
  titleLarge = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, lineHeight = 26.sp),
  titleMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 22.sp),
  titleSmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 20.sp),
  bodyLarge = TextStyle(fontFamily = Sans, fontSize = 16.sp, lineHeight = 24.sp),
  bodyMedium = TextStyle(fontFamily = Sans, fontSize = 14.sp, lineHeight = 20.sp),
  bodySmall = TextStyle(fontFamily = Sans, fontSize = 13.sp, lineHeight = 18.sp),
  // Section markers: small, spaced and upper-cased at the call site, so a heading reads as a label on an
  // instrument rather than as a sentence that lost its verb.
  labelLarge = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Medium, fontSize = 14.sp, letterSpacing = 0.2.sp),
  labelMedium = TextStyle(
    fontFamily = Sans,
    fontWeight = FontWeight.SemiBold,
    fontSize = 11.sp,
    letterSpacing = 1.1.sp,
  ),
  labelSmall = TextStyle(fontFamily = Mono, fontSize = 11.sp, letterSpacing = 0.4.sp),
)

@Composable
fun MagnetGateTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
  CompositionLocalProvider(LocalStateColors provides if (dark) DarkState else LightState) {
    MaterialTheme(
      colorScheme = if (dark) DarkScheme else LightScheme,
      typography = MgTypography,
      content = content,
    )
  }
}
