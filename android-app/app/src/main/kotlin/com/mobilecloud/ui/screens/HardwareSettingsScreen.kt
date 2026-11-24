package com.mobilecloud.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AcUnit
import androidx.compose.material.icons.filled.BatteryChargingFull
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.core.DeviceTelemetry
import com.mobilecloud.core.TelemetryProvider
import com.mobilecloud.security.HardwareAttestation
import com.mobilecloud.ui.components.GlowCard
import com.mobilecloud.ui.components.IconBadge
import com.mobilecloud.ui.components.KVRow
import com.mobilecloud.ui.components.RefSourceChip
import com.mobilecloud.ui.components.SectionLabel
import com.mobilecloud.ui.theme.AppFonts
import com.mobilecloud.ui.theme.Aurora
import kotlinx.coroutines.delay

/**
 * Safety — Hardware Protection & Security, Aurora edition (blueprint Screen
 * 6). Device readings and the local keystore; no node or thermal enforcement.
 */
@Composable
fun HardwareSettingsScreen() {
    val context = LocalContext.current
    var telemetry by remember { mutableStateOf<DeviceTelemetry?>(null) }
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
                Text("Settings", color = Aurora.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp)
                Text("Power, thermals & hardware shield", color = Aurora.TextMid, fontSize = 11.sp)
            }
            IconBadge(Icons.Filled.Shield, Aurora.Cyan, size = 32.dp, iconSize = 16.dp)
        }

        Spacer(Modifier.height(14.dp))

        val t = telemetry

        // ---- Battery lifespan shield ----
        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Border, corner = 12.dp) {
            Column(Modifier.padding(16.dp)) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconBadge(Icons.Filled.BatteryChargingFull, Aurora.Cyan, size = 28.dp, iconSize = 15.dp)
                        Spacer(Modifier.width(8.dp))
                        SectionLabel("BATTERY TELEMETRY")
                    }
                }
                Spacer(Modifier.height(12.dp))
                if (t == null) {
                    Text("reading BatteryManager…", color = Aurora.TextLow, fontSize = 12.sp, fontFamily = AppFonts.Mono)
                } else {
                    KVRow("Charge state", "${t.battery.status} · ${t.battery.percentLabel}")
                    KVRow("Cell current", t.battery.currentLabel)
                    KVRow("Cell temperature", t.battery.temperatureLabel)
                    RefSourceChip("BatteryManager · no bypass verification")
                }
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Hardware keystore (evidence-backed) ----
        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Border, corner = 12.dp) {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconBadge(Icons.Filled.Key, Aurora.Cyan, size = 28.dp, iconSize = 15.dp)
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
                    fontSize = 14.sp, fontWeight = FontWeight.Bold, fontFamily = AppFonts.Mono,
                )
                Spacer(Modifier.height(4.dp))
                KVRow("Algorithm", keystore.keyAlgorithm)
                KVRow("PubKey SHA-256", keystore.publicKeySha256.take(18) + "…", valueColor = Aurora.Cyan)
                Text(keystore.detail, color = Aurora.TextMid, fontSize = 10.5.sp, lineHeight = 14.sp)
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = { keystore = HardwareAttestation.rotateKey() },
                    modifier = Modifier.fillMaxWidth().height(40.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Aurora.CardAlt),
                    shape = RoundedCornerShape(8.dp),
                ) {
                    Text("Rotate Key (real)", color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Thermal readings ----
        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Red.copy(alpha = 0.35f), corner = 12.dp) {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconBadge(Icons.Filled.AcUnit, Aurora.Red, size = 28.dp, iconSize = 15.dp)
                    Spacer(Modifier.width(8.dp))
                    SectionLabel("THERMAL TELEMETRY", color = Aurora.Red)
                }
                Spacer(Modifier.height(12.dp))
                Text("Readings only. No local workload or automatic thermal cutoff.", color = Aurora.TextMid, fontSize = 11.5.sp)
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
                    fontSize = 12.sp, fontFamily = AppFonts.Mono,
                )
                Spacer(Modifier.height(8.dp))
                RefSourceChip("sysfs thermal")
            }
        }
    }
}
