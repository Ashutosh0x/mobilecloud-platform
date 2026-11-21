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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AcUnit
import androidx.compose.material.icons.filled.BatteryChargingFull
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.core.DeviceTelemetry
import com.mobilecloud.core.TelemetryProvider
import com.mobilecloud.core.TradingEngineController
import com.mobilecloud.security.HardwareAttestation
import com.mobilecloud.ui.components.GlowCard
import com.mobilecloud.ui.components.IconBadge
import com.mobilecloud.ui.components.RefSourceChip
import com.mobilecloud.ui.components.SectionLabel
import com.mobilecloud.ui.components.StatusPill
import com.mobilecloud.ui.theme.Aurora
import kotlinx.coroutines.delay

/**
 * Safety — Hardware Protection & Security, Aurora edition (blueprint Screen
 * 6). Real evidence only: BatteryManager + sysfs thermals live, StrongBox-
 * first keystore probe with real rotation, auto-halt wired to the persisted
 * fail-closed TradingEngineController.
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
            .background(Aurora.Bg)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(top = 14.dp, bottom = 96.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text("Settings", color = Aurora.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text("Power, thermals & hardware shield", color = Aurora.TextFaint, fontSize = 11.sp)
            }
            IconBadge(Icons.Filled.Shield, Aurora.GlowGreen, size = 32.dp, iconSize = 16.dp)
        }

        Spacer(Modifier.height(14.dp))

        val t = telemetry

        // ---- Battery lifespan shield ----
        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.GlowGreen.copy(alpha = 0.5f)) {
            Column(Modifier.padding(16.dp)) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconBadge(Icons.Filled.BatteryChargingFull, Aurora.GlowGreen, size = 28.dp, iconSize = 15.dp)
                        Spacer(Modifier.width(8.dp))
                        SectionLabel("BATTERY LIFESPAN SHIELD")
                    }
                    if (t != null) {
                        StatusPill(
                            if (t.battery.bypassActive) "BYPASS" else "NORMAL",
                            color = if (t.battery.bypassActive) Aurora.GlowGreen else Aurora.Amber,
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
                if (t == null) {
                    Text("reading BatteryManager…", color = Aurora.TextLow, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                } else {
                    KVRow("Charge state", "${t.battery.batteryStatus} · ${t.battery.batteryPercent}% · ${t.battery.batteryCurrentMicroAmps / 1000} mA")
                    KVRow("Cell temperature", "%.1f °C".format(t.battery.batteryTempTenthsC / 10.0))
                    Text(
                        if (t.battery.bypassActive)
                            "Bypass charging DETECTED — battery isolated at ~0 mA (zero cell wear)"
                        else
                            "Bypass charging NOT DETECTED — cell charges normally (device must support charge separation)",
                        color = if (t.battery.bypassActive) Aurora.GlowGreen else Aurora.Amber,
                        fontSize = 11.5.sp, lineHeight = 15.sp,
                    )
                    Spacer(Modifier.height(6.dp))
                    RefSourceChip("BatteryManager + probe")
                }
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Hardware keystore (evidence-backed) ----
        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Purple.copy(alpha = 0.5f)) {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconBadge(Icons.Filled.Key, Aurora.Purple, size = 28.dp, iconSize = 15.dp)
                    Spacer(Modifier.width(8.dp))
                    SectionLabel("HARDWARE KEYSTORE (EVIDENCE-BACKED)")
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    "Security level: ${keystore.securityLevel}",
                    color = when (keystore.securityLevel) {
                        "STRONGBOX" -> Aurora.GlowGreen
                        "TEE" -> Aurora.Cyan
                        else -> Aurora.Amber
                    },
                    fontSize = 14.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                )
                Spacer(Modifier.height(4.dp))
                KVRow("Algorithm", keystore.keyAlgorithm)
                KVRow("PubKey SHA-256", keystore.publicKeySha256.take(18) + "…", valueColor = Aurora.Periwinkle)
                Text(keystore.detail, color = Aurora.TextFaint, fontSize = 10.5.sp, lineHeight = 14.sp)
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = { keystore = HardwareAttestation.rotateKey() },
                    modifier = Modifier.fillMaxWidth().height(44.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Aurora.PurpleDeep),
                    shape = RoundedCornerShape(12.dp),
                ) {
                    Text("Rotate Key (real)", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Emergency failover (wired to persisted controller) ----
        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Red.copy(alpha = 0.45f)) {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconBadge(Icons.Filled.AcUnit, Aurora.Red, size = 28.dp, iconSize = 15.dp)
                    Spacer(Modifier.width(8.dp))
                    SectionLabel("EMERGENCY FAILOVER", color = Aurora.Red)
                }
                Spacer(Modifier.height(12.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Auto-Halt on Overheat (>45°C SoC)", color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                        Text(
                            "Supervisor trips the persisted trading-engine halt (fail-closed)",
                            color = Aurora.TextFaint, fontSize = 10.5.sp,
                        )
                    }
                    Switch(
                        checked = autoShutdownOverheat,
                        onCheckedChange = {
                            autoShutdownOverheat = it
                            TradingEngineController.setThermalAutoHalt(context, it)
                        },
                        colors = SwitchDefaults.colors(
                            checkedTrackColor = Aurora.Red,
                            checkedThumbColor = Color.White,
                            uncheckedTrackColor = Aurora.Track,
                            uncheckedThumbColor = Aurora.TextLow,
                        ),
                    )
                }
                Spacer(Modifier.height(10.dp))
                val soc = t?.socTempC
                Text(
                    "Current SoC zone: " + (soc?.let { "%.1f °C (%s)".format(it, t!!.socTempSource ?: "sysfs") } ?: "UNAVAILABLE"),
                    color = when {
                        soc == null -> Aurora.TextLow
                        soc > 45.0 -> Aurora.Red
                        soc > 41.0 -> Aurora.Amber
                        else -> Aurora.GlowGreen
                    },
                    fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                )
                Spacer(Modifier.height(6.dp))
                val halted = TradingEngineController.state.value.halted
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(8.dp).background(if (halted) Aurora.Red else Aurora.GlowGreen, CircleShape)
                    )
                    Spacer(Modifier.width(7.dp))
                    Text(
                        if (halted)
                            "Trading engine: HALTED — ${TradingEngineController.state.value.reason}"
                        else
                            "Trading engine state: clear",
                        color = if (halted) Aurora.Red else Aurora.GlowGreen,
                        fontSize = 11.5.sp, fontFamily = FontFamily.Monospace,
                    )
                }
                Spacer(Modifier.height(8.dp))
                RefSourceChip("sysfs thermal · TradingEngineController")
            }
        }
    }
}
