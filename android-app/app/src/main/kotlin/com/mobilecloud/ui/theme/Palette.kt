package com.mobilecloud.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * MobileCloud Unified Design System tokens — 100% synchronized with the
 * Next.js Web Console (`globals.css`):
 *   --bg:       #0A0A0F (main background)
 *   --header:   #0A0A0F
 *   --card:     #12121A (card/panel surface)
 *   --elevated: #1A1A25 (elevated surface / row hover)
 *   --accent:   #0066FF (Electric Azure Blue)
 *   --cyan:     #00D4FF (edge/CDN elements)
 *   --text:     #FFFFFF (headings, primary text)
 *   --muted:    #9CA3AF (labels, descriptions)
 *   --faint:    #6B7280 (timestamps, metadata)
 *   --line:     #2A2A35 (1px crisp borders)
 *   --divider:  #22222C (list row dividers)
 *   --green:    #00C853 (success, healthy, active)
 *   --amber:    #FF6D00 (warnings, attention)
 *   --red:      #FF1744 (errors, critical)
 *   --purple:   #7C4DFF (FurlPay / finance)
 *   --gold:     #FFD600 (earnings, rewards)
 *   --radius:   8px / 12px
 */
object Aurora {
    val Bg = Color(0xFF0A0A0F)            // --bg
    val BgDeep = Color(0xFF0A0A0F)        // --header
    val Card = Color(0xFF12121A)          // --card
    val CardAlt = Color(0xFF1A1A25)       // --elevated
    val CardWell = Color(0xFF0C0C12)      // inset terminal / meter wells
    val Border = Color(0xFF2A2A35)        // --line
    val BorderGlow = Color(0x330066FF)    // subtle accent glow (~20% α)

    val GlowGreen = Color(0xFF00C853)     // --green
    val GreenSoft = Color(0xFF00C853)     // online dot / success indicator
    val GreenDeep = Color(0xFF0B291B)     // online pill container
    val Cyan = Color(0xFF0066FF)          // --accent
    val Blue = Color(0xFF0066FF)          // --accent
    val Edge = Color(0xFF00D4FF)          // --cyan
    val Purple = Color(0xFF7C4DFF)        // --purple
    val PurpleDeep = Color(0xFF221452)    // active nav container
    val Amber = Color(0xFFFF6D00)         // --amber
    val Red = Color(0xFFFF1744)           // --red
    val RedDeep = Color(0xFF2E0912)       // halt icon container
    val Gold = Color(0xFFFFD600)          // --gold
    val Periwinkle = Color(0xFF7C4DFF)    // SPECIMEN badge

    val TextHi = Color(0xFFFFFFFF)        // --text
    val TextMid = Color(0xFF9CA3AF)       // --muted
    val TextLow = Color(0xFF6B7280)       // --faint
    val TextFaint = Color(0xFF52525B)     // subtle footnotes
    val ChipBg = Color(0xFF1A1A25)        // --elevated / hover
    val ChipText = Color(0xFFFFFFFF)      // --text
    val Track = Color(0xFF22222C)         // --divider
    val Divider = Color(0xFF22222C)       // --divider
}

/** Cross-fade surface aliases so screens read naturally. */
val AuroraBg = Aurora.Bg
val AuroraCard = Aurora.Card
val AuroraCardAlt = Aurora.CardAlt
