package com.mobilecloud.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.R

/**
 * Cyber-Institutional Design System (CIDS) tokens — UI/UX spec section 1.1,
 * upgraded to the full 3-layer token architecture extracted from GitHub
 * Android v1.284.0 (decompilation report §8, §20.2–20.3, §20.8, §20.14.2–3):
 *
 *   Layer 1 — SCALE:      21-step neutral gray scale + 7 chromatic hues
 *                         (Primer values, verbatim from the decompiled APK).
 *   Layer 2 — SEMANTIC:   meaning-bearing tokens (success / danger / warning /
 *                         info / done, borders, diff views) decoupled from hue.
 *   Layer 3 — COMPONENT:  Material3 ColorScheme + Typography + Shapes +
 *                         badge spec (bg 16% α + label + stroke 32% α).
 *
 * The edge node UI is permanently dark by default (CIDS spec: headless server
 * console on AMOLED — the OLED baseline #070A13 draws near-zero pixel power,
 * < 0.08 W display budget). A complete light scheme ships anyway so a future
 * high-brightness / accessibility mode needs no re-derivation.
 */
val Background = Color(0xFF000000) // --bg: #000000 (pure black OLED baseline)
val Surface = Color(0xFF111111) // --card: #111111 (elevated cards, panels)
val SurfaceElevated = Color(0xFF1A1A1A) // --elevated: #1a1a1a (inputs, chips, borders)
val Primary = Color(0xFF0070F3) // --accent: #0070f3 (electric azure)
val Accent = Color(0xFF0070F3) // --accent: #0070f3
val Success = Color(0xFF00E599) // --green: #00e599 (electric emerald)
val Warning = Color(0xFFF5A623) // --amber: #f5a623 (warm amber)
val Critical = Color(0xFFEE0000) // --red: #ee0000 (vibrant crimson)
val TextPrimary = Color(0xFFEDEDED) // --text: #ededed (high-contrast off-white)
val TextSecondary = Color(0xFF888888) // --muted: #888888 (medium gray metadata)
val MonospaceCode = Color(0xFF00E599) // --green: #00e599 (terminal output, hashes)

// Screen-facing aliases (existing screens import these names).
val BgDark = Background
val SurfaceDark = Surface
val SurfaceElevatedDark = SurfaceElevated
val PrimaryCyan = Primary
val AccentIndigo = Accent
val SuccessEmerald = Success
val WarnAmber = Warning
val WarningAmber = Warning
val CriticalRose = Critical
val CriticalCrimson = Critical
val TerminalGreen = MonospaceCode

// ---------------------------------------------------------------------------
// LAYER 1 — SCALE. Primer scales extracted verbatim from the decompiled APK
// (report §20.2.3 gray scale, §20.2.4 chromatic scales).
// ---------------------------------------------------------------------------
object PrimerGray {
    val s0000 = Color(0xFFFFFFFF) // gray_000
    val s0050 = Color(0xFFFBFBFC) // gray_050
    val s0100 = Color(0xFFF7F7F9) // gray_100
    val s0150 = Color(0xFFEFF0F5) // gray_150 — app bg (light)
    val s0200 = Color(0xFFE3E4E8) // gray_200 — dividers
    val s0250 = Color(0xFFD6D7DC) // gray_250 — disabled states
    val s0300 = Color(0xFFBFC1C9) // gray_300 — secondary text (dark)
    val s0350 = Color(0xFFA9ABB6) // gray_350 — hover states
    val s0400 = Color(0xFF9194A1) // gray_400 — tertiary text (dark)
    val s0450 = Color(0xFF787C8C) // gray_450 — mid-tone icons
    val s0500 = Color(0xFF6C6F7E) // gray_500
    val s0550 = Color(0xFF5E616E) // gray_550
    val s0600 = Color(0xFF525560) // gray_600 — primary icons (light)
    val s0650 = Color(0xFF4B4D58) // gray_650
    val s0700 = Color(0xFF41434E) // gray_700 — secondary text (light)
    val s0750 = Color(0xFF383A42) // gray_750 — elevated bg (dark)
    val s0800 = Color(0xFF2E2F37) // gray_800
    val s0850 = Color(0xFF1F1F24) // gray_850 — tertiary bg (dark)
    val s0900 = Color(0xFF17181C) // gray_900 — secondary bg (dark)
    val s0950 = Color(0xFF0B0B0D) // gray_950 — near-black surface
    val s1000 = Color(0xFF050505) // gray_1000 — app bg (dark)
}

object PrimerBlue {
    val s000 = Color(0xFFF5FAFF)
    val s300 = Color(0xFF85BEFF) // dark-mode accent / link
    val s500 = Color(0xFF0D6EDB)
    val s600 = Color(0xFF0366D6) // light-mode link
    val s700 = Color(0xFF0B498F)
    val s900 = Color(0xFF082A52)
}

object PrimerGreen {
    val s000 = Color(0xFFF5FFF8)
    val s300 = Color(0xFF95F0AB)
    val s500 = Color(0xFF32B24F)
    val s700 = Color(0xFF1E7533)
    val s900 = Color(0xFF184D25)
}

object PrimerRed {
    val s000 = Color(0xFFFFF0F2)
    val s300 = Color(0xFFFF808D)
    val s500 = Color(0xFFE04352)
    val s600 = Color(0xFFBD222D) // light-mode danger
    val s700 = Color(0xFFBD222D)
    val s900 = Color(0xFF8F1D22)
}

object PrimerYellow {
    val s000 = Color(0xFFFFFEF5)
    val s300 = Color(0xFFFFEC8A)
    val s500 = Color(0xFFFFD74D)
    val s700 = Color(0xFFE0B112)
    val s900 = Color(0xFF755F13)
}

object PrimerOrange {
    val s000 = Color(0xFFFFFAF5)
    val s300 = Color(0xFFFFAE75)
    val s500 = Color(0xFFFA6F0F)
    val s700 = Color(0xFFD65C09)
    val s900 = Color(0xFFA84603)
}

object PrimerPurple {
    val s000 = Color(0xFFF6F2FF)
    val s300 = Color(0xFFB899F0)
    val s500 = Color(0xFF7548C7)
    val s700 = Color(0xFF522E8F)
    val s900 = Color(0xFF2E1757)
}

object PrimerPink {
    val s000 = Color(0xFFFFF0F9)
    val s300 = Color(0xFFFA9BD4)
    val s500 = Color(0xFFF051B0)
    val s700 = Color(0xFFC2428E)
    val s900 = Color(0xFF702653)
}

// ---------------------------------------------------------------------------
// LAYER 2 — SEMANTIC tokens, decoupled from hue (report §20.2.2 dark-mode
// foundation values + §20.2.5 semantic states).
// ---------------------------------------------------------------------------
val Info = Color(0xFF85BEFF) // informational / links in dark (blue_300)
val Done = Color(0xFFA371F7) // completed lifecycle items (GitHub "done")
val BorderSubtle = Color(0xFFBFC1C9).copy(alpha = 0.16f) // dark border rgba(191,193,201,.16)
val BorderOpaque = Color(0xFF41434E) // gray_700 — visible dark borders
val DividerDark = Color(0xFF17181C) // gray_900 — dark dividers
val InputBackground = Color(0xFFBFC1C9).copy(alpha = 0.12f)

// Diff viewer tokens, dark set (report §20.2.7) — for CloudShell diffs,
// config-change views and reserve-delta displays (§8 lesson #4).
object DiffTokens {
    val additionBg = Color(0xFF061C0B)
    val additionLineBg = Color(0xFF08260F)
    val additionText = PrimerGreen.s300
    val deletionBg = Color(0xFF300406)
    val deletionLineBg = Color(0xFF3B0507)
    val deletionText = PrimerRed.s300
    val hunkBg = Color(0xFF081F39)
    val hunkLineBg = Color(0xFF092442)
    val hunkText = PrimerBlue.s300
    val neutralBg = Color(0xFF17181C)
    val neutralLineBg = Color(0xFF1F1F24)
    val neutralText = Color(0xFF9194A1)
}

// Light-mode diff set for the future light scheme (report §20.2.7 light col).
object LightDiffTokens {
    val additionBg = Color(0xFFF0FFF4)
    val additionLineBg = Color(0xFFDCFFE4)
    val additionText = Color(0xFF22863A)
    val deletionBg = Color(0xFFFFEEF0)
    val deletionLineBg = Color(0xFFFFDCE0)
    val deletionText = Color(0xFFCB2431)
}

// ---------------------------------------------------------------------------
// COMPONENT LAYER — Badge spec: background (16% α) + label + stroke (32% α)
// (report §20.2.6 / §20.14.2: "6-color badge system: bg 16% α + label +
// stroke 32% α").
// ---------------------------------------------------------------------------
data class BadgeColors(val background: Color, val label: Color, val stroke: Color)

fun badgeColors(accent: Color, label: Color = accent): BadgeColors =
    BadgeColors(background = accent.copy(alpha = 0.16f), label = label, stroke = accent.copy(alpha = 0.32f))

// ---------------------------------------------------------------------------
// Motion system — Material Motion curves extracted from the APK
// (report §20.8.1). Wire into Animated* transitions.
// ---------------------------------------------------------------------------
val MotionStandard = CubicBezierEasing(0.2f, 0f, 0f, 1f) // default UI transitions
val MotionEmphasizedAccelerate = CubicBezierEasing(0.3f, 0f, 0.8f, 0.2f) // exit
val MotionEmphasizedDecelerate = CubicBezierEasing(0.1f, 0.7f, 0.1f, 1f) // enter
val MotionLinear = CubicBezierEasing(0f, 0f, 1f, 1f) // progress indicators
val MotionLegacy = CubicBezierEasing(0.4f, 0f, 0.2f, 1f) // fallback standard

// ---------------------------------------------------------------------------
// FONTS — bundled at res/font, 1:1 with the web console stack
// (apps/web-dashboard/app/layout.tsx): Geist for UI (--font-sans),
// Geist Mono for data/telemetry (--font-mono), and JetBrains Mono for the
// CloudShell terminal surface (same face as the xterm.js web CloudShell).
// ---------------------------------------------------------------------------
object AppFonts {
    /** Web --font-sans: Geist. Default for every typography slot. */
    val Sans = FontFamily(
        Font(R.font.geist_400, FontWeight.Normal),
        Font(R.font.geist_500, FontWeight.Medium),
        Font(R.font.geist_600, FontWeight.SemiBold),
        Font(R.font.geist_700, FontWeight.Bold),
    )

    /** Web --font-mono: Geist Mono. Tables, badges, kbd hints, nav sections, telemetry. */
    val Mono = FontFamily(
        Font(R.font.geist_mono_400, FontWeight.Normal),
        Font(R.font.geist_mono_500, FontWeight.Medium),
        Font(R.font.geist_mono_700, FontWeight.Bold),
    )

    /** CloudShell terminal face — web-cloudshell xterm.js uses JetBrains Mono 14px. */
    val Terminal = FontFamily(
        Font(R.font.jetbrains_mono_400, FontWeight.Normal),
        Font(R.font.jetbrains_mono_700, FontWeight.Bold),
    )
}

// ---------------------------------------------------------------------------
// LAYER 3 — Typography: 7-step scale from the APK dimens (report §20.3.2):
// 13 / 14 / 16 / 18 / 20 / 22 / 24 sp. Geist is the default family (web
// parity); data screens use AppFonts.Mono at call sites.
// ---------------------------------------------------------------------------
private val CidsTypography = Typography(
    displayLarge = TextStyle(fontFamily = AppFonts.Sans, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.8).sp, lineHeight = 30.sp),
    displayMedium = TextStyle(fontFamily = AppFonts.Sans, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.8).sp, lineHeight = 28.sp),
    headlineSmall = TextStyle(fontFamily = AppFonts.Sans, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.6).sp, lineHeight = 26.sp),
    titleLarge = TextStyle(fontFamily = AppFonts.Sans, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.6).sp, lineHeight = 26.sp),
    titleMedium = TextStyle(fontFamily = AppFonts.Sans, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.4).sp, lineHeight = 24.sp),
    titleSmall = TextStyle(fontFamily = AppFonts.Sans, fontSize = 16.sp, fontWeight = FontWeight.Medium, letterSpacing = (-0.3).sp, lineHeight = 22.sp),
    bodyLarge = TextStyle(fontFamily = AppFonts.Sans, fontSize = 16.sp, fontWeight = FontWeight.Normal, letterSpacing = (-0.15).sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontFamily = AppFonts.Sans, fontSize = 14.sp, fontWeight = FontWeight.Normal, letterSpacing = (-0.15).sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontFamily = AppFonts.Sans, fontSize = 13.sp, fontWeight = FontWeight.Normal, letterSpacing = (-0.15).sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontFamily = AppFonts.Sans, fontSize = 14.sp, fontWeight = FontWeight.Medium, letterSpacing = (-0.15).sp),
    labelMedium = TextStyle(fontFamily = AppFonts.Sans, fontSize = 13.sp, fontWeight = FontWeight.Medium, letterSpacing = (-0.15).sp),
    labelSmall = TextStyle(fontFamily = AppFonts.Mono, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp),
)

private val CidsShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(8.dp),   // --radius: 8px
    medium = RoundedCornerShape(10.dp), // cards
    large = RoundedCornerShape(12.dp),
    extraLarge = RoundedCornerShape(16.dp), // bottom sheets
)

// Full dark ColorScheme — CIDS identity on the Primer container ladder.
private val CidsDarkColorScheme = darkColorScheme(
    primary = Primary,
    onPrimary = Background,
    primaryContainer = PrimerBlue.s900,
    onPrimaryContainer = PrimerBlue.s300,
    inversePrimary = PrimerBlue.s600,
    secondary = Accent,
    onSecondary = Background,
    secondaryContainer = PrimerPurple.s900,
    onSecondaryContainer = PrimerPurple.s300,
    tertiary = Info,
    onTertiary = Background,
    tertiaryContainer = PrimerBlue.s900,
    onTertiaryContainer = PrimerBlue.s300,
    background = Background,
    onBackground = TextPrimary,
    surface = Surface,
    onSurface = TextPrimary,
    surfaceVariant = SurfaceElevated,
    onSurfaceVariant = TextSecondary,
    surfaceTint = Primary,
    inverseSurface = PrimerGray.s0050,
    inverseOnSurface = PrimerGray.s1000,
    error = Critical,
    onError = Background,
    errorContainer = PrimerRed.s900,
    onErrorContainer = PrimerRed.s300,
    outline = BorderOpaque,
    outlineVariant = BorderSubtle,
    scrim = Color(0xFF000000),
    surfaceDim = PrimerGray.s1000,
    surfaceBright = PrimerGray.s0900,
    surfaceContainerLowest = PrimerGray.s0950,
    surfaceContainerLow = Surface,
    surfaceContainer = SurfaceElevated,
    surfaceContainerHigh = PrimerGray.s0800,
    surfaceContainerHighest = PrimerGray.s0750,
)

// Full light ColorScheme — shipped for future accessibility / outdoor mode
// (GitHub light foundation values, report §20.2.1).
private val CidsLightColorScheme = lightColorScheme(
    primary = PrimerBlue.s600,
    onPrimary = Color.White,
    primaryContainer = PrimerBlue.s000,
    onPrimaryContainer = PrimerBlue.s700,
    inversePrimary = PrimerBlue.s300,
    secondary = PrimerPurple.s500,
    onSecondary = Color.White,
    secondaryContainer = PrimerPurple.s000,
    onSecondaryContainer = PrimerPurple.s700,
    tertiary = PrimerBlue.s500,
    onTertiary = Color.White,
    tertiaryContainer = PrimerBlue.s000,
    onTertiaryContainer = PrimerBlue.s700,
    background = PrimerGray.s0150,
    onBackground = PrimerGray.s1000,
    surface = Color.White,
    onSurface = PrimerGray.s1000,
    surfaceVariant = PrimerGray.s0100,
    onSurfaceVariant = PrimerGray.s0700,
    surfaceTint = PrimerBlue.s600,
    inverseSurface = PrimerGray.s1000,
    inverseOnSurface = PrimerGray.s0050,
    error = PrimerRed.s600,
    onError = Color.White,
    errorContainer = PrimerRed.s000,
    onErrorContainer = PrimerRed.s700,
    outline = PrimerGray.s0300,
    outlineVariant = PrimerGray.s0200,
    scrim = Color(0xFF000000),
    surfaceDim = PrimerGray.s0200,
    surfaceBright = Color.White,
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = PrimerGray.s0100,
    surfaceContainer = PrimerGray.s0150,
    surfaceContainerHigh = PrimerGray.s0200,
    surfaceContainerHighest = PrimerGray.s0250,
)

@Composable
fun MobileCloudTheme(
    darkTheme: Boolean = true, // CIDS pins dark for the OLED power budget
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) CidsDarkColorScheme else CidsLightColorScheme,
        typography = CidsTypography,
        shapes = CidsShapes,
        content = content,
    )
}
