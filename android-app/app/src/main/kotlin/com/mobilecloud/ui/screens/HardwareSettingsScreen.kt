package com.mobilecloud.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.core.DeviceTelemetry
import com.mobilecloud.core.TelemetryProvider
import com.mobilecloud.core.TradingEngineController
import com.mobilecloud.security.HardwareAttestation
import com.mobilecloud.ui.components.ProvenanceChip
import com.mobilecloud.ui.theme.*
import kotlinx.coroutines.delay

/**
 * Screen 6: Hardware Protection & Security (CIDS spec), rebuilt with REAL
 * evidence only (audit prompt Phase 6):
 *
 *  - Battery/thermal values come from BatteryManager + sysfs, refreshed live.
 *  - Bypass charging is reported as DETECTED / NOT DETECTED from the actual
 *    probe — never assumed from chipset marketing.
 *  - The keystore card generates an AndroidKeyStore EC key (StrongBox-first
 *    with TEE fallback) and reports the security level the keystore daemon
 *    actually returned, plus the public-key digest. Rotate Key really rotates.
 *  - Auto-halt is wired to the persisted fail-closed TradingEngineController:
 *    the supervisor loop trips it at >45 °C SoC.
 */
@Composable
fun HardwareSettingsScreen() {
    val context = LocalContext.current
    var telemetry by remember { mutableStateOf<DeviceTelemetry?>(null) }
    var autoShutdownOverheat by remember { mutableStateOf(TradingEngineController.thermalAutoHalt.value) }
    var keystore by remember {
        mutableStateOf(HardwareAttestation.Result("…", "-", "-", "probing AndroidKeyStore"))
    }

    LaunchedEffect(Unit) {
        while (true) {
            telemetry = TelemetryProvider.snapshot(context)
            delay(3000)
        }
    }
    LaunchedEffect(Unit) { keystore = HardwareAttestation.ensureIdentityKey() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .background(BgDark)
            .padding(16.dp)
    ) {
        Text("Hardware Protection & Security", style = MaterialTheme.typography.titleMedium, color = TextPrimary)

        Spacer(modifier = Modifier.height(16.dp))

        // Battery Shield — real readings.
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = SurfaceDark),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("BATTERY LIFESPAN SHIELD", color = TextSecondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(12.dp))
                val t = telemetry
                if (t == null) {
                    com.mobilecloud.ui.components.ProgressiveLoadingIndicator()
                } else {
                    TelemetryLine(
                        "Charge state",
                        "${t.battery.batteryStatus} · ${t.battery.batteryPercent}% · ${t.battery.batteryCurrentMicroAmps / 1000} mA"
                    )
                    TelemetryLine("Cell temperature", "${t.battery.batteryTempTenthsC / 10.0} °C")
                    val bypass = t.battery.bypassActive
                    Text(
                        if (bypass) "Bypass charging: DETECTED (battery isolated at ~0 mA)"
                        else "Bypass charging: NOT DETECTED — cell charges normally (device must support charge separation)",
                        color = if (bypass) SuccessEmerald else WarnAmber, fontSize = 12.sp
                    )
                    ProvenanceChip("BatteryManager + probe")
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Real hardware keystore evidence.
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = SurfaceDark),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("HARDWARE KEYSTORE (EVIDENCE-BACKED)", color = TextSecondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    "Security level: ${keystore.securityLevel}",
                    color = when (keystore.securityLevel) {
                        "STRONGBOX" -> SuccessEmerald
                        "TEE" -> PrimaryCyan
                        else -> WarnAmber
                    },
                    fontSize = 14.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace
                )
                Text("Algorithm: ${keystore.keyAlgorithm}", color = TextPrimary, fontSize = 12.sp)
                Text("PubKey SHA-256: ${keystore.publicKeySha256}", color = AccentIndigo, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                Spacer(modifier = Modifier.height(4.dp))
                Text(keystore.detail, color = TextSecondary, fontSize = 11.sp)
                Spacer(modifier = Modifier.height(12.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { keystore = HardwareAttestation.rotateKey() },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = SurfaceElevatedDark)
                    ) {
                        Text("Rotate Key (real)", color = TextPrimary, fontSize = 12.sp)
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Thermal guard — wired to the persisted fail-closed controller.
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = SurfaceDark),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("EMERGENCY FAILOVER", color = TextSecondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(12.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Auto-Halt on Overheat (>45°C SoC)", color = TextPrimary, fontWeight = FontWeight.Medium)
                        Text(
                            "Supervisor trips the persisted trading-engine halt (fail-closed)",
                            color = TextSecondary, fontSize = 12.sp
                        )
                    }
                    Switch(
                        checked = autoShutdownOverheat,
                        onCheckedChange = {
                            autoShutdownOverheat = it
                            TradingEngineController.setThermalAutoHalt(context, it)
                        }
                    )
                }
                Spacer(modifier = Modifier.height(8.dp))
                val t = telemetry
                val soc = t?.socTempC
                Text(
                    "Current SoC zone: " + (soc?.let { "%.1f °C (%s)".format(it, t!!.socTempSource ?: "sysfs") } ?: "UNAVAILABLE"),
                    color = when {
                        soc == null -> TextSecondary
                        soc > 45.0 -> CriticalCrimson
                        soc > 41.0 -> WarnAmber
                        else -> SuccessEmerald
                    },
                    fontSize = 12.sp, fontFamily = FontFamily.Monospace
                )
                Text(
                    "Trading engine state: " + (
                        if (TradingEngineController.state.value.halted)
                            "HALTED — ${TradingEngineController.state.value.reason}"
                        else "clear"
                        ),
                    color = if (TradingEngineController.state.value.halted) CriticalCrimson else SuccessEmerald,
                    fontSize = 12.sp, fontFamily = FontFamily.Monospace
                )
                ProvenanceChip("sysfs thermal · TradingEngineController")
            }
        }
    }
}

@Composable
private fun TelemetryLine(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text(label, color = TextSecondary, fontSize = 12.sp, modifier = Modifier.weight(1f))
        Text(value, color = TextPrimary, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
    }
}
