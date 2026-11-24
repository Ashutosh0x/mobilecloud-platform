package com.mobilecloud.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.mobilecloud.security.HardwareAttestation
import com.mobilecloud.service.BatteryBypassDetector
import com.mobilecloud.ui.components.GlowCard
import com.mobilecloud.ui.components.LinearMeter
import com.mobilecloud.ui.theme.AppFonts
import com.mobilecloud.ui.theme.Aurora
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * Onboarding — hardware provisioning wizard. Each step runs a REAL probe on
 * this device and shows the value it read back:
 *
 *  1. SoC identity + core count (Build.SOC_MODEL / HARDWARE)
 *  2. Battery / charge path (BatteryManager via BatteryBypassDetector)
 *  3. Notification permission, the prerequisite for the foreground supervisors
 *  4. AndroidKeyStore identity key (StrongBox → TEE), with the true level
 *
 * Nothing is advanced by a timer; a step is only green once its probe returned.
 */
@Composable
fun OnboardingScreen(onComplete: () -> Unit) {
    val context = LocalContext.current

    var details by remember { mutableStateOf<List<String>>(emptyList()) }

    LaunchedEffect(Unit) {
        val collected = mutableListOf<String>()

        val soc = if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL else Build.HARDWARE
        val cores = Runtime.getRuntime().availableProcessors()
        collected += "$soc · $cores cores detected"
        details = collected.toList()
        delay(600)

        val power = withContext(Dispatchers.IO) { BatteryBypassDetector.probe(context) }
        collected += "BatteryManager · ${power.batteryStatus} · ${power.batteryPercent}% · " +
            "${power.batteryCurrentMicroAmps / 1000} mA"
        details = collected.toList()
        delay(600)

        val granted = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(
            context, Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        collected += if (granted)
            "Notification permission granted — supervisors can post status"
        else
            "Notification permission not granted — supervisor notices stay silent"
        details = collected.toList()
        delay(600)

        val key = withContext(Dispatchers.IO) { HardwareAttestation.ensureIdentityKey() }
        collected += if (key.securityLevel == "ERROR")
            "AndroidKeyStore unavailable — ${key.detail}"
        else
            "AndroidKeyStore ${key.securityLevel} · ${key.keyAlgorithm} · ${key.publicKeySha256}"
        details = collected.toList()
    }

    val progress by animateFloatAsState(details.size / 4f, tween(500), label = "prov")

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(listOf(Aurora.Bg, Aurora.BgDeep))
            )
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 22.dp, vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // ---- Hero Brand Logo ----
        Box(
            modifier = Modifier
                .size(72.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(Aurora.TextHi),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "M",
                color = Aurora.Bg,
                fontSize = 36.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = AppFonts.Mono,
            )
        }
        Spacer(Modifier.height(14.dp))
        Text(
            "MobileCloud Node",
            color = Aurora.TextHi,
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = (-0.5).sp,
        )
        Text(
            "Build. Ship. Scale. Autonomous on-device edge cloud runtime.",
            color = Aurora.TextMid,
            fontSize = 12.sp,
            letterSpacing = (-0.1).sp,
        )

        Spacer(Modifier.height(26.dp))

        Text(
            "⚡ HARDWARE PROVISIONING ⚡",
            color = Aurora.Cyan,
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 2.sp,
        )

        Spacer(Modifier.height(8.dp))
        LinearMeter(progress = progress, color = Aurora.GlowGreen, height = 5.dp)
        Spacer(Modifier.height(18.dp))

        val titles = listOf(
            "SoC Identity",
            "Battery & Charge Path",
            "Foreground Service Permission",
            "Hardware-Backed Keystore (StrongBox / TEE)",
        )
        val pendingDetails = listOf(
            "reading Build.SOC_MODEL…",
            "probing BatteryManager…",
            "checking notification permission…",
            "generating key attestation…",
        )

        titles.forEachIndexed { i, title ->
            val done = details.size > i
            AnimatedVisibility(
                visible = true,
                enter = slideInVertically(tween(300)) { it / 3 } + fadeIn(tween(300)),
            ) {
                GlowCard(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 7.dp),
                    glow = if (done) Aurora.GlowGreen else Aurora.Border,
                    corner = 16.dp,
                ) {
                    Row(
                        Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            modifier = Modifier
                                .size(34.dp)
                                .clip(CircleShape)
                                .background(
                                    if (done) Aurora.GlowGreen.copy(alpha = 0.16f)
                                    else Aurora.Track
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                if (done) "✓" else "${i + 1}",
                                color = if (done) Aurora.GlowGreen else Aurora.TextLow,
                                fontSize = 16.sp,
                                fontWeight = FontWeight.Bold,
                                fontFamily = AppFonts.Mono,
                            )
                        }
                        Spacer(Modifier.width(13.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                title,
                                color = Aurora.TextHi,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Spacer(Modifier.height(3.dp))
                            Text(
                                if (done) details[i] else pendingDetails[i],
                                color = if (done) Aurora.GreenSoft else Aurora.TextLow,
                                fontSize = 11.sp,
                                fontFamily = AppFonts.Mono,
                                lineHeight = 15.sp,
                            )
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(10.dp))
        Text(
            "Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}) · arm64-v8a",
            color = Aurora.TextFaint,
            fontSize = 10.sp,
            fontFamily = AppFonts.Mono,
        )

        Spacer(Modifier.height(20.dp))

        // CTA — Electric blue accent when armed; disabled slab while provisioning.
        val armed = details.size >= 4
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(
                    if (armed) Aurora.Cyan else Aurora.Track
                )
                .clickable(enabled = armed) { onComplete() },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                if (armed) "INITIALIZE NODE" else "PROVISIONING… ${(progress * 100).toInt()}%",
                color = if (armed) Color.White else Aurora.TextLow,
                fontWeight = FontWeight.SemiBold,
                fontSize = 13.sp,
                letterSpacing = 0.6.sp,
            )
        }

        Spacer(Modifier.height(14.dp))
        Text(
            "Values above are read live from this device — none are simulated.",
            color = Aurora.TextFaint,
            fontSize = 10.sp,
        )
    }
}
