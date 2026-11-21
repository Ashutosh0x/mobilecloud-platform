package com.mobilecloud.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.core.NodeModeState
import com.mobilecloud.core.TradingEngineController
import com.mobilecloud.ui.components.DotTickSlider
import com.mobilecloud.ui.components.GlowCard
import com.mobilecloud.ui.components.HoldToConfirmButton
import com.mobilecloud.ui.components.SectionLabel
import com.mobilecloud.ui.theme.Aurora
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Trading — HFT Arbitrage Engine, Aurora edition (reference 4).
 *
 * Honesty contract unchanged: NO venue clients are wired, nothing executes
 * on-chain; feed rows are labelled SPECIMEN. The Emergency Halt remains a
 * REAL fail-closed controller (persisted; gates future submission paths;
 * also tripped by the thermal supervisor).
 */
private data class SpecimenTrade(
    val time: String,
    val bundleId: String,
    val route: String,
    val profit: String,
    val bps: String,
    val toxic: Boolean = false,
)

@Composable
fun TradingScreen() {
    val context = LocalContext.current
    var minSpreadBps by remember { mutableFloatStateOf(12f) }
    val haltState by TradingEngineController.state.collectAsState()
    val mode by NodeModeState.mode.collectAsState()
    val haptics = LocalHapticFeedback.current

    val feed = remember {
        listOf(
            SpecimenTrade("14:02:11.428", "#8912 (specimen)", "Backpack ($88.40) → Raydium ($88.58)", "+$9.00 est. (not realized)", "16.2 bps"),
            SpecimenTrade("14:02:08.114", "#8911 (specimen)", "Backpack ($88.35) → Orca ($88.51)", "+$19.20 est. (not realized)", "18.1 bps"),
            SpecimenTrade("14:01:55.802", "#8910 (specimen)", "Toxic Arb Detected → Competitor Front-Run", "$0.00 · reverted inside VM", "—", toxic = true),
            SpecimenTrade("14:01:41.770", "#8909 (specimen)", "Backpack ($88.41) → Raydium ($88.55)", "+$7.00 est. (not realized)", "15.8 bps"),
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Aurora.Bg)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(top = 14.dp, bottom = 96.dp),
    ) {
        ScreenTitle("Trading", "HFT arbitrage engine")

        Spacer(Modifier.height(12.dp))

        // ---- Mode notice (amber, ref4) ----
        ModeCard(
            modeLabel = mode.label,
            modeColor = Aurora.Amber,
            detail = "No venue API clients are configured. Nothing below was executed on-chain; estimated profit is NOT realized profit. Proof of execution will require transaction signatures + wallet reconciliation.",
        )

        Spacer(Modifier.height(13.dp))

        // ---- Specimen quotes (big mono) ----
        GlowCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                SectionLabel("SPECIMEN QUOTES — ANT / USDC (NOT LIVE)")
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Backpack CLOB: \$88.40", color = Aurora.TextHi, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace)
                    Spacer(Modifier.width(10.dp))
                    Text("▶", color = Aurora.Blue, fontSize = 16.sp)
                    Spacer(Modifier.width(10.dp))
                    Text("Raydium AMM:", color = Aurora.TextHi, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace)
                    Text("\$88.58", color = Aurora.TextHi, fontSize = 17.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    "Illustrative dislocation: +18.4 bps — a live adapter must recompute from real order books",
                    color = Aurora.TextLow,
                    fontSize = 11.sp,
                )
            }
        }

        Spacer(Modifier.height(15.dp))

        SectionLabel("SPECIMEN EXECUTION FEED (ILLUSTRATIVE FORMAT)")
        Spacer(Modifier.height(8.dp))

        feed.forEach { trade ->
            GlowCard(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 5.dp),
                background = Aurora.CardAlt,
                corner = 14.dp,
                glow = if (trade.toxic) Aurora.Red.copy(alpha = 0.4f) else Aurora.Border,
            ) {
                Column(Modifier.padding(13.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(
                            "${trade.time} • ${trade.bundleId}",
                            color = Aurora.TextLow,
                            fontSize = 10.5.sp,
                            fontFamily = FontFamily.Monospace,
                        )
                        SpecimenBadge()
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        trade.route,
                        color = if (trade.toxic) Aurora.Red else Aurora.TextHi,
                        fontSize = 13.5.sp,
                        fontWeight = FontWeight.Medium,
                    )
                    Spacer(Modifier.height(6.dp))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(
                            "Est. Profit: ${trade.profit}",
                            color = if (trade.toxic) Aurora.TextLow else Aurora.TextMid,
                            fontSize = 11.5.sp,
                        )
                        Text(trade.bps, color = Aurora.Cyan, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace)
                    }
                }
            }
        }

        Spacer(Modifier.height(15.dp))

        // ---- Risk controls with reference dotted slider ----
        GlowCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(horizontal = 16.dp).padding(top = 16.dp, bottom = 6.dp)) {
                SectionLabel("RISK CONTROLS (STAGED FOR LIVE MODE)")
                Spacer(Modifier.height(10.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Min Spread Threshold", color = Aurora.TextMid, fontSize = 14.sp)
                    Text(
                        "%.1f bps".format(minSpreadBps),
                        color = Aurora.Cyan,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                DotTickSlider(
                    value = minSpreadBps,
                    onValueChange = { minSpreadBps = it },
                    range = 5f..30f,
                )
                Text(
                    "Fail-closed policy: submission paths abort unless engine state is clear",
                    color = Color(0xFF58B7E8),
                    fontSize = 10.5.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.padding(bottom = 10.dp),
                )
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Halted state / emergency button ----
        if (haltState.halted) {
            GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Red, corner = 14.dp, background = Aurora.Red.copy(alpha = 0.12f)) {
                Column(Modifier.padding(13.dp)) {
                    Text(
                        "TRADING ENGINE HALTED — fail-closed, persisted across restarts",
                        color = Aurora.Red, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "Reason: ${haltState.reason.ifEmpty { "operator emergency stop" }} · ${
                            SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(haltState.haltedAtEpochMs))
                        }",
                        color = Aurora.TextLow, fontSize = 10.5.sp,
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
        }

        HoldToConfirmButton(
            text = "🛑  EMERGENCY HALT TRADING (HOLD 1.5s)",
            holdingText = { p -> "HOLD TO HALT… ${(p * 100).toInt()}%" },
            onConfirm = {
                haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                TradingEngineController.halt(context, "Operator emergency stop (long-press hold)")
            },
            enabled = !haltState.halted,
        )

        if (haltState.halted) {
            Spacer(Modifier.height(8.dp))
            Text(
                "Resume is an explicit operator authorization (tap to authorize) — the engine stays halted across restarts until then.",
                color = Aurora.TextFaint, fontSize = 10.sp,
            )
        }
    }
}

@Composable
private fun SpecimenBadge() {
    Text(
        "SPECIMEN",
        color = Aurora.Periwinkle,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.8.sp,
        modifier = Modifier
            .clip(RoundedCornerShape(5.dp))
            .background(Aurora.Periwinkle.copy(alpha = 0.14f))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
private fun ModeCard(modeLabel: String, modeColor: Color, detail: String) {
    GlowCard(Modifier.fillMaxWidth(), glow = modeColor.copy(alpha = 0.4f), corner = 14.dp) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Warning, null, tint = modeColor, modifier = Modifier.size(13.dp))
                Spacer(Modifier.width(6.dp))
                Text("MODE: ", color = Aurora.TextLow, fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                Text(modeLabel, color = modeColor, fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
            }
            Spacer(Modifier.height(6.dp))
            Text(detail, color = Aurora.TextMid, fontSize = 11.5.sp, lineHeight = 16.sp)
        }
    }
}

@Composable
private fun ScreenTitle(title: String, subtitle: String) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column {
            Text(title, color = Aurora.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text(subtitle, color = Aurora.TextFaint, fontSize = 11.sp)
        }
        Box(Modifier.size(34.dp).clip(RoundedCornerShape(11.dp)).background(Aurora.Card), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.ShowChart, null, tint = Aurora.Cyan, modifier = Modifier.size(17.dp))
        }
    }
}
