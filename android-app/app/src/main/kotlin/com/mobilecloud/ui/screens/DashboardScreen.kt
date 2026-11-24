package com.mobilecloud.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Power
import androidx.compose.material.icons.filled.Router
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.Thermostat
import androidx.compose.material.icons.filled.BatteryStd
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import com.mobilecloud.ui.theme.AppFonts
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.core.DeviceTelemetry
import com.mobilecloud.core.TelemetryProvider
import com.mobilecloud.ui.components.FooterTagline
import com.mobilecloud.ui.components.GlowCard
import com.mobilecloud.ui.components.IconBadge
import com.mobilecloud.ui.components.LinearMeter
import com.mobilecloud.ui.components.MetricCard
import com.mobilecloud.ui.components.ProgressRing
import com.mobilecloud.ui.components.RefSourceChip
import com.mobilecloud.ui.components.SectionLabel
import com.mobilecloud.ui.components.StatusPill
import com.mobilecloud.ui.theme.Aurora
import kotlinx.coroutines.delay

/**
 * Dashboard — Aurora Console edition (reference 8): glowing hero identity
 * card, three metric cards, battery ring card, telemetry grid, honest-gap
 * list. Every value remains REAL telemetry from this device; unavailable
 * measurements stay honestly labelled (never invented).
 */
@Composable
fun DashboardScreen() {
    val context = LocalContext.current
    var telemetry by remember { mutableStateOf<DeviceTelemetry?>(null) }
    var detailsOpen by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        while (true) {
            telemetry = TelemetryProvider.snapshot(context)
            delay(3000)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Aurora.Bg)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(top = 14.dp, bottom = 96.dp),
    ) {
        // ---- Header row (ref8): brand + online pill + bell + avatar ----
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(Aurora.TextHi),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "M",
                        color = Aurora.Bg,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = AppFonts.Mono,
                    )
                }
                Spacer(Modifier.width(10.dp))
                Column {
                    Text(
                        "MobileCloud",
                        color = Aurora.TextHi,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = (-0.4).sp,
                    )
                    Text(
                        "Build. Ship. Scale.",
                        color = Aurora.TextMid,
                        fontSize = 11.sp,
                        letterSpacing = (-0.1).sp,
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusPill("Online", color = Aurora.GreenSoft)
                Spacer(Modifier.width(8.dp))
                Box(
                    Modifier
                        .size(34.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(Aurora.Card)
                        .border(1.dp, Aurora.Border, RoundedCornerShape(8.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Filled.Notifications, null,
                        tint = Aurora.TextMid, modifier = Modifier.size(16.dp),
                    )
                    Box(
                        Modifier
                            .padding(top = 7.dp, end = 7.dp)
                            .size(5.dp)
                            .align(Alignment.TopEnd)
                            .background(Aurora.Cyan, CircleShape)
                    )
                }
                Spacer(Modifier.width(8.dp))
                Box(
                    Modifier
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(Aurora.CardAlt)
                        .border(1.dp, Aurora.Border, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { Text("A", color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
            }
        }

        Spacer(Modifier.height(16.dp))

        val t = telemetry
        if (t == null) {
            GlowCard(Modifier.fillMaxWidth()) {
                Box(Modifier.fillMaxWidth().padding(28.dp), contentAlignment = Alignment.Center) {
                    Text("reading live telemetry…", color = Aurora.TextLow, fontSize = 12.sp, fontFamily = AppFonts.Mono)
                }
            }
            return@Column
        }

        // ---- Hero: device identity card ----
        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Cyan, corner = 12.dp) {
            Box {
                Row(
                    Modifier.padding(16.dp).fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconBadge(Icons.Filled.Devices, Aurora.Cyan, size = 44.dp, iconSize = 22.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        SectionLabel("DEVICE NODE", color = Aurora.TextLow)
                        Spacer(Modifier.height(3.dp))
                        Text(
                            t.deviceModel,
                            color = Aurora.TextHi,
                            fontSize = 20.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = (-0.4).sp,
                        )
                        Text(
                            "${t.socModel ?: t.deviceBoard} · Android ${t.androidRelease} (SDK ${t.sdkInt}) · arm64-v8a",
                            color = Aurora.TextMid,
                            fontSize = 11.sp,
                            fontFamily = AppFonts.Mono,
                        )
                    }
                }
                Icon(
                    Icons.Filled.VerifiedUser, null,
                    tint = Aurora.Cyan,
                    modifier = Modifier.align(Alignment.TopEnd).padding(14.dp).size(18.dp),
                )
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Metric trio ----
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            MetricCard(
                label = "UPTIME",
                value = TelemetryProvider.formatUptime(t.uptimeMs),
                icon = Icons.Filled.Schedule,
                accent = Aurora.GlowGreen,
                modifier = Modifier.weight(1f),
            )
            MetricCard(
                label = "SoC TEMP",
                value = t.socTempC?.let { "%.1f°C".format(it) } ?: "N/A",
                icon = Icons.Filled.Thermostat,
                accent = when {
                    t.socTempC == null -> Aurora.Cyan
                    t.socTempC > 45.0 -> Aurora.Red
                    t.socTempC > 41.0 -> Aurora.Amber
                    else -> Aurora.GlowGreen
                },
                chip = {
                    StatusPill(
                        when {
                            t.socTempC == null -> "no zone"
                            t.socTempC > 45.0 -> "Hot"
                            t.socTempC > 41.0 -> "Warm"
                            else -> "Normal"
                        },
                        color = when {
                            t.socTempC == null -> Aurora.TextLow
                            t.socTempC > 45.0 -> Aurora.Red
                            t.socTempC > 41.0 -> Aurora.Amber
                            else -> Aurora.GreenSoft
                        },
                    )
                },
                modifier = Modifier.weight(1f),
            )
            MetricCard(
                label = "BATTERY",
                value = t.battery.percentLabel,
                icon = Icons.Filled.BatteryStd,
                accent = Aurora.Blue,
                meter = t.battery.batteryPercent?.div(100f),
                modifier = Modifier.weight(1f),
            )
        }

        Spacer(Modifier.height(13.dp))

        // ---- Battery & Power (ring + three honest rows) ----
        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Blue.copy(alpha = 0.55f), corner = 20.dp) {
            Column(Modifier.padding(16.dp)) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconBadge(Icons.Filled.Bolt, Aurora.GlowGreen, size = 28.dp, iconSize = 15.dp)
                        Spacer(Modifier.width(8.dp))
                        SectionLabel("BATTERY & POWER")
                    }
                    Box(Modifier.clickable { detailsOpen = !detailsOpen }) {
                        StatusPill(
                            if (detailsOpen) "Hide" else "Details →",
                            color = Aurora.Blue,
                            bg = Aurora.Blue.copy(alpha = 0.08f),
                            bold = false,
                        )
                    }
                }
                Spacer(Modifier.height(14.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ProgressRing(
                        progress = t.battery.batteryPercent?.div(100f) ?: 0f,
                        color = Aurora.GlowGreen,
                        size = 118.dp, stroke = 10.dp,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(Icons.Filled.BatteryStd, null, tint = Aurora.GlowGreen, modifier = Modifier.size(18.dp))
                            Text(t.battery.percentLabel, color = Aurora.TextHi, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                            Text("Battery", color = Aurora.TextFaint, fontSize = 10.sp)
                        }
                    }
                    Spacer(Modifier.width(16.dp))
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.Bolt, null, tint = Aurora.GlowGreen, modifier = Modifier.size(14.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("Charge State", color = Aurora.TextLow, fontSize = 11.sp)
                        }
                        Spacer(Modifier.height(4.dp))
                        Text(t.battery.status, color = Aurora.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(2.dp))
                        Text(
                            "Cell: ${t.battery.temperatureLabel} · Current: ${t.battery.currentLabel}",
                            color = Aurora.TextFaint,
                            fontSize = 11.sp,
                        )
                        Spacer(Modifier.height(8.dp))
                        RefSourceChip("BatteryManager")
                    }
                }
                PowerDivider()
                PowerRow(
                    icon = Icons.Filled.Power,
                    tint = Aurora.TextLow,
                    label = "Wall Power Draw",
                    value = "UNAVAILABLE",
                    valueColor = Aurora.TextMid,
                    detail = "Requires an external meter (smart plug / PDU).",
                    source = "honest gap",
                )
            }
        }

        if (detailsOpen) {
        Spacer(Modifier.height(13.dp))

        // ---- Hardware telemetry grid ----
        GlowCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                SectionLabel("HARDWARE TELEMETRY")
                Spacer(Modifier.height(10.dp))
                TelemetryTile(
                    Icons.Filled.Memory, Aurora.Cyan, "CPU",
                    "${t.coresOnline}/${t.coreCount} ONLINE",
                    t.currentMaxCoreKHz?.let { "now %.2f GHz · max %.2f GHz".format(it / 1e6, (t.highestCoreMaxKHz ?: it) / 1e6) }
                        ?: "freq sysfs not exposed by kernel",
                    "sysfs cpufreq",
                )
                TelemetryTile(
                    Icons.Filled.Thermostat, Aurora.Red, "THERMAL ZONE",
                    t.socTempC?.let { "%.1f °C".format(it) } ?: "UNAVAILABLE",
                    t.socTempSource ?: "no cpu* zone readable",
                    "sysfs thermal",
                )
                TelemetryTile(
                    Icons.Filled.Storage, Aurora.Purple, "MEMORY",
                    "${t.memUsedPct}% USED",
                    "${t.memAvailMb} MB free / ${t.memTotalMb} MB",
                    "ActivityManager",
                    meter = t.memUsedPct / 100f,
                )
                TelemetryTile(
                    Icons.Filled.Storage, Aurora.GlowGreen, "STORAGE (/DATA)",
                    "${t.storageUsedPct}% USED",
                    "%.1f GB free of %.0f GB".format(t.storageFreeGb, t.storageTotalGb),
                    "StatFs",
                    meter = t.storageUsedPct / 100f,
                )
                TelemetryTile(
                    Icons.Filled.Router, Aurora.Blue, "TRAFFIC (SINCE BOOT)",
                    "RX %.1f GB · TX %.1f GB".format((t.rxBytesSinceBoot ?: 0) / 1e9, (t.txBytesSinceBoot ?: 0) / 1e9),
                    "all interfaces, device-wide",
                    "TrafficStats",
                )
            }
        }

        Spacer(Modifier.height(13.dp))

        GlowCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                SectionLabel("LOCAL RUNTIME")
                Spacer(Modifier.height(8.dp))
                Text("Console only. No local node runtime is included.", color = Aurora.TextMid, fontSize = 11.5.sp)
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Honest gaps ----
        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Red.copy(alpha = 0.4f)) {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.WarningAmber, null, tint = Aurora.Red, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(6.dp))
                    SectionLabel("NOT CONNECTED IN THIS BUILD", color = Aurora.Red)
                }
                Spacer(Modifier.height(8.dp))
                listOf(
                    "Solana/Jito execution — no exchange connectivity configured; no orders signed",
                    "PoR reconciliation — needs the por-kernel daemon on 127.0.0.1:3000",
                    "Mesh — no WireGuard/libp2p tunnels configured",
                    "Stellar Soroban attestation — no contract deployed/referenced",
                ).forEach { name ->
                    Row(Modifier.padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(6.dp).background(Aurora.Red, CircleShape))
                        Spacer(Modifier.width(8.dp))
                        Text(name, color = Aurora.TextLow, fontSize = 11.5.sp)
                    }
                }
            }
        }
        }

        Spacer(Modifier.height(18.dp))
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            FooterTagline()
        }
    }
}

@Composable
private fun PowerDivider() {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp)
            .height(1.dp)
            .background(Aurora.Divider)
    )
}

@Composable
private fun PowerRow(
    icon: ImageVector,
    tint: Color,
    label: String,
    value: String,
    detail: String,
    source: String,
    valueColor: Color = Aurora.TextHi,
) {
    Row(verticalAlignment = Alignment.Top) {
        IconBadge(icon, tint, size = 26.dp, iconSize = 14.dp)
        Spacer(Modifier.width(9.dp))
        Column(Modifier.weight(1f)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(label, color = Aurora.TextLow, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                RefSourceChip(source)
            }
            Text(value, color = valueColor, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            Text(detail, color = Aurora.TextFaint, fontSize = 10.5.sp, lineHeight = 13.sp)
        }
    }
}

@Composable
private fun TelemetryTile(
    icon: ImageVector,
    accent: Color,
    label: String,
    value: String,
    detail: String,
    source: String,
    meter: Float? = null,
) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.Top) {
        IconBadge(icon, accent, size = 30.dp, iconSize = 16.dp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(label, color = Aurora.TextMid, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Text(value, color = Aurora.TextHi, fontSize = 11.5.sp, fontWeight = FontWeight.Bold, fontFamily = AppFonts.Mono)
            }
            Spacer(Modifier.height(2.dp))
            Text(detail, color = Aurora.TextFaint, fontSize = 9.5.sp)
            if (meter != null) {
                Spacer(Modifier.height(5.dp))
                LinearMeter(progress = meter, color = accent, height = 4.dp)
            }
            Spacer(Modifier.height(4.dp))
            RefSourceChip(source)
        }
    }
}
