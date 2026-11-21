package com.mobilecloud.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.core.NodeModeState
import com.mobilecloud.core.OperatingMode
import com.mobilecloud.core.TradingEngineController
import com.mobilecloud.ui.components.ModeBanner
import com.mobilecloud.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Screen 2: HFT Arbitrage Engine (CIDS spec), rebuilt under the honesty layer
 * (audit prompt Phase 3 / Phase 11).
 *
 * This build has NO exchange connectivity: no Backpack/Raydium/Jito clients
 * are wired, no transactions are signed or submitted. The rows below are
 * clearly-labelled SPECIMEN data illustrating what the execution feed will
 * look like once a live venue adapter exists. The Emergency Halt is a REAL
 * fail-closed controller: it persists, gates any future submission path via
 * [TradingEngineController.requireClear], and is also tripped by the thermal
 * supervisor.
 */
data class TradeLogEntry(
    val time: String,
    val bundleId: String,
    val buyVenue: String,
    val sellVenue: String,
    val netProfitUsdc: String,
    val spreadBps: String,
    val isCommitted: Boolean
)

@Composable
fun TradingScreen() {
    val context = LocalContext.current
    var minSpreadBps by remember { mutableStateOf(12f) }
    val haltState by TradingEngineController.state.collectAsState()
    val mode by NodeModeState.mode.collectAsState()

    val recentTrades = remember {
        listOf(
            TradeLogEntry("14:02:11.428", "#8912 (specimen)", "Backpack ($88.40)", "Raydium ($88.58)", "+$9.00 est.", "16.2 bps", true),
            TradeLogEntry("14:02:08.114", "#8911 (specimen)", "Backpack ($88.35)", "Orca ($88.51)", "+$19.20 est.", "18.1 bps", true),
            TradeLogEntry("14:01:55.802", "#8910 (specimen)", "Toxic Arb Detected", "Competitor Front-Run", "$0.00", "Reverted Inside VM", false)
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BgDark)
            .padding(16.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("HFT Arbitrage Engine", style = MaterialTheme.typography.titleMedium, color = TextPrimary)
            AssistChip(
                onClick = {},
                label = { Text("SIMULATION — NO REAL ORDERS", color = Warning, fontWeight = FontWeight.Bold, fontSize = 10.sp) },
                colors = AssistChipDefaults.assistChipColors(containerColor = SurfaceElevatedDark)
            )
        }

        Spacer(modifier = Modifier.height(10.dp))

        ModeBanner(
            mode = mode,
            detail = "No venue API clients are configured. Nothing below was executed on-chain; estimated profit is NOT realized profit. Proof of execution will require transaction signatures + wallet reconciliation.",
        )

        Spacer(modifier = Modifier.height(12.dp))

        // Spread card — specimen quotes, labelled as such.
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = SurfaceDark),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("SPECIMEN QUOTES — ANT / USDC (NOT LIVE)", color = TextSecondary, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(8.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Backpack CLOB: $88.40", color = TextPrimary, fontFamily = FontFamily.Monospace)
                    Text("►", color = PrimaryCyan)
                    Text("Raydium AMM: $88.58", color = TextPrimary, fontFamily = FontFamily.Monospace)
                }
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    "Illustrative dislocation: +18.4 bps — a live adapter must recompute from real order books",
                    color = TextSecondary, fontSize = 12.sp
                )
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        Text("SPECIMEN EXECUTION FEED (ILLUSTRATIVE FORMAT)", color = TextSecondary, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Spacer(modifier = Modifier.height(8.dp))

        LazyColumn(modifier = Modifier.weight(1f)) {
            items(recentTrades) { trade ->
                Card(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    colors = CardDefaults.cardColors(containerColor = SurfaceDark),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("${trade.time} • ${trade.bundleId}", color = TextSecondary, fontSize = 11.sp)
                            Text(
                                "SPECIMEN",
                                color = AccentIndigo,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        Spacer(modifier = Modifier.height(4.dp))
                        Text("${trade.buyVenue} ➔ ${trade.sellVenue}", color = TextPrimary, fontSize = 13.sp)
                        Spacer(modifier = Modifier.height(4.dp))
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Est. Profit: ${trade.netProfitUsdc} (not realized)", color = TextSecondary, fontWeight = FontWeight.Medium)
                            Text(trade.spreadBps, color = PrimaryCyan, fontSize = 12.sp)
                        }
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Dynamic risk controls (configuration persisted for the future LIVE path).
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = SurfaceDark),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("RISK CONTROLS (STAGED FOR LIVE MODE)", color = TextSecondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(8.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Min Spread Threshold", color = TextPrimary, fontSize = 13.sp)
                    Text(String.format("%.1f bps", minSpreadBps), color = PrimaryCyan, fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                }
                Slider(
                    value = minSpreadBps,
                    onValueChange = { minSpreadBps = it },
                    valueRange = 5f..30f,
                    steps = 24,
                    colors = SliderDefaults.colors(
                        thumbColor = PrimaryCyan,
                        activeTrackColor = PrimaryCyan,
                        inactiveTrackColor = SurfaceElevatedDark,
                    )
                )
                Text(
                    "Fail-closed policy: submission paths abort unless engine state is clear",
                    color = TextSecondary, fontSize = 11.sp, fontFamily = FontFamily.Monospace
                )
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // REAL emergency halt — persisted, fail-closed, also tripped by thermal guard.
        val scope = rememberCoroutineScope()
        val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
        var holdProgress by remember { mutableStateOf(0f) }

        if (haltState.halted) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = Critical.copy(alpha = 0.15f)),
                shape = RoundedCornerShape(8.dp)
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        "TRADING ENGINE HALTED — fail-closed, persisted across restarts",
                        color = Critical, fontSize = 12.sp, fontWeight = FontWeight.Bold
                    )
                    Text(
                        "Reason: ${haltState.reason.ifEmpty { "operator emergency stop" }} · ${java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date(haltState.haltedAtEpochMs))}",
                        color = TextSecondary, fontSize = 11.sp
                    )
                }
            }
            Spacer(modifier = Modifier.height(8.dp))
        }

        androidx.compose.material3.Surface(
            shape = RoundedCornerShape(8.dp),
            color = CriticalCrimson,
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .pointerInput(haltState.halted) {
                    detectTapGestures(
                        onPress = {
                            if (!haltState.halted) {
                                val job = scope.launch {
                                    // 30 × 50ms = 1.5s hold with haptic ramp-up.
                                    for (i in 1..30) {
                                        delay(50)
                                        holdProgress = i / 30f
                                        haptics.performHapticFeedback(
                                            androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress
                                        )
                                    }
                                    TradingEngineController.halt(
                                        context,
                                        "Operator emergency stop (long-press hold)"
                                    )
                                    holdProgress = 0f
                                }
                                tryAwaitRelease()
                                job.cancel()
                                holdProgress = 0f
                            }
                        }
                    )
                }
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text(
                    when {
                        holdProgress > 0f -> "HOLD TO HALT… ${(holdProgress * 100).toInt()}%"
                        haltState.halted -> "RESUME ENGINE (TAP TO AUTHORIZE)"
                        else -> "🛑 EMERGENCY HALT TRADING (HOLD 1.5s)"
                    },
                    color = Color.White, fontWeight = FontWeight.Bold, fontSize = 13.sp
                )
            }
        }
        if (holdProgress > 0f) {
            LinearProgressIndicator(
                progress = { holdProgress },
                color = Color.White,
                trackColor = CriticalCrimson.copy(alpha = 0.4f),
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp)
            )
        }
        if (haltState.halted) {
            Text(
                "Resume is an explicit operator authorization (audit prompt Phase 3 §Emergency Halt §7).",
                color = TextSecondary, fontSize = 10.sp, modifier = Modifier.padding(top = 4.dp)
            )
        }
    }
}
