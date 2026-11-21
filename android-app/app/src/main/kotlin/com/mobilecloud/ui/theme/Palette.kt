package com.mobilecloud.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * MobileCloud Unified Design System tokens — 100% synchronized with the
 * Next.js Web Console (`globals.css`):
 *   --bg:       #000000 (Pure black, OLED 0W idle)
 *   --header:   #000000
 *   --card:     #111111 (Deep dark surface)
 *   --elevated: #1a1a1a (Elevated surface / row hover)
 *   --accent:   #0070f3 (Electric Azure Blue)
 *   --text:     #ededed (Off-white high contrast)
 *   --muted:    #888888 (Medium gray metadata)
 *   --faint:    #555555 (Subtle captions / key hints)
 *   --line:     #333333 (1px crisp borders)
 *   --divider:  #222222 (List row dividers)
 *   --green:    #00e599 (Electric Emerald active / live)
 *   --amber:    #f5a623 (Warm Amber warning)
 *   --red:      #ee0000 (Vibrant Red error / halted)
 *   --radius:   8px / 12px
 */
object Aurora {
    val Bg = Color(0xFF000000)            // --bg: #000000 (pure black)
    val BgDeep = Color(0xFF000000)        // --header: #000000
    val Card = Color(0xFF111111)          // --card: #111111
    val CardAlt = Color(0xFF1A1A1A)       // --elevated: #1a1a1a
    val CardWell = Color(0xFF0A0A0A)      // inset terminal / meter wells
    val Border = Color(0xFF333333)        // --line: #333333
    val BorderGlow = Color(0x330070F3)    // subtle accent glow (~20% α)

    val GlowGreen = Color(0xFF00E599)     // --green: #00e599 (electric emerald)
    val GreenSoft = Color(0xFF00E599)     // online dot / success indicator
    val GreenDeep = Color(0xFF0B291B)     // online pill container
    val Cyan = Color(0xFF0070F3)          // --accent: #0070f3 (electric azure)
    val Blue = Color(0xFF0070F3)          // --accent: #0070f3
    val Purple = Color(0xFF0070F3)        // active nav mapped to web accent
    val PurpleDeep = Color(0xFF0B213E)    // active nav container
    val Amber = Color(0xFFF5A623)         // --amber: #f5a623
    val Red = Color(0xFFEE0000)           // --red: #ee0000
    val RedDeep = Color(0xFF2E0909)       // halt icon container
    val Gold = Color(0xFFF5A623)          // PoR section heading
    val Periwinkle = Color(0xFF0070F3)    // SPECIMEN badge

    val TextHi = Color(0xFFEDEDED)        // --text: #ededed
    val TextMid = Color(0xFF888888)       // --muted: #888888
    val TextLow = Color(0xFF555555)       // --faint: #555555
    val TextFaint = Color(0xFF444444)     // subtle footnotes
    val ChipBg = Color(0xFF1A1A1A)        // --elevated / hover
    val ChipText = Color(0xFFEDEDED)      // --text
    val Track = Color(0xFF222222)         // --divider
    val Divider = Color(0xFF222222)       // --divider: #222222
}

/** Cross-fade surface aliases so screens read naturally. */
val AuroraBg = Aurora.Bg
val AuroraCard = Aurora.Card
val AuroraCardAlt = Aurora.CardAlt
