package com.mobilecloud.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * "Aurora Console" — the reference-design token set extracted from the eight
 * approved UI/UX screenshots (2026-11-21). Layered ON TOP of the CIDS tokens
 * in Theme.kt; existing imports keep compiling while new screens consume the
 * reference-exact surfaces below.
 *
 * Reference mapping:
 *   Background      #0A0E17 → #0D1117 range (near-black navy, OLED)
 *   SurfaceCard     #121926 / #141C2B (cards)   #10192B (alt rows)
 *   GlowGreen       #00E88A / #22E58C (identity glow, online, success)
 *   Cyan            #3FA9F5 / #4DA3FF (bps, links, sliders)
 *   Purple          #6C5CE7 pill / #5B4B9E deep (active nav)
 *   Amber           #E8A33D (SIMULATION mode, "NOT DETECTED")
 *   Red             #E5484D (DEGRADED, temp alert, halt button)
 *   Gold            #E8A33D (PoR "VERIFICATION STATUS" heading)
 */
object Aurora {
    val Bg = Color(0xFF0A0E17)            // page background
    val BgDeep = Color(0xFF070A12)        // status-bar / deeper wells
    val Card = Color(0xFF121A29)          // standard card surface
    val CardAlt = Color(0xFF10192B)       // feed rows / alternate surfaces
    val CardWell = Color(0xFF0D1524)      // inset wells (terminal, meters)
    val Border = Color(0xFF1E293B)        // subtle card border
    val BorderGlow = Color(0x4D00E88A)    // green glow border (~30% α)

    val GlowGreen = Color(0xFF00E88A)     // primary identity green
    val GreenSoft = Color(0xFF22E58C)     // online dot / footer text
    val GreenDeep = Color(0xFF0E2E1E)     // online pill bg
    val Cyan = Color(0xFF3FA9F5)          // metrics / slider fill
    val Blue = Color(0xFF4DA3FF)          // battery, links, chips
    val Purple = Color(0xFF6C5CE7)        // active nav icon accent
    val PurpleDeep = Color(0xFF5B4B9E)    // active nav pill bg
    val Amber = Color(0xFFE8A33D)         // simulation / warnings
    val Red = Color(0xFFE5484D)           // degraded / halt / hot temp
    val RedDeep = Color(0xFFC23329)       // halt icon well
    val Gold = Color(0xFFE8A33D)          // PoR section heading
    val Periwinkle = Color(0xFF7B8CFF)    // SPECIMEN badge

    val TextHi = Color(0xFFF2F6FF)        // primary text
    val TextMid = Color(0xFFB8C4D6)       // body text
    val TextLow = Color(0xFF8A93A6)       // labels / timestamps
    val TextFaint = Color(0xFF6B7688)     // captions / footnotes
    val ChipBg = Color(0xFF16223A)        // src-chip bg
    val ChipText = Color(0xFF7FA8D9)      // src-chip text
    val Track = Color(0xFF1B2537)         // progress track
    val Divider = Color(0xFF1C2434)       // row dividers
}

/** Cross-fade surface aliases so screens read naturally. */
val AuroraBg = Aurora.Bg
val AuroraCard = Aurora.Card
val AuroraCardAlt = Aurora.CardAlt
