package com.mobilecloud.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.text.FontFamily
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.mobilecloud.ui.theme.Accent
import com.mobilecloud.ui.theme.Background
import com.mobilecloud.ui.theme.TextPrimary
import com.mobilecloud.ui.theme.TextSecondary

/**
 * Home-screen widget #2: PoR Solvency (GitHub Agent-Tasks-widget slot).
 *
 * Backing ratio + five-tier badge, refreshed by
 * [com.mobilecloud.work.PorAttestationWorker] hourly. A ratio below 99.50%
 * renders CRITICAL red — the same tripwire as the Soroban circuit breaker.
 */
class PorSolvencyWidget : GlanceAppWidget() {

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snap = WidgetStateStore.snapshot(context)
        provideContent {
            GlanceTheme {
                PorContent(snap)
            }
        }
    }

    @Composable
    private fun PorContent(snap: WidgetSnapshot) {
        val tier = porTierFor(snap)
        val tierColor = Color(tier.argb)

        Column(
            modifier = GlanceModifier.fillMaxSize().background(ColorProvider(Background)).padding(10.dp),
            verticalAlignment = Alignment.Vertical.Top,
        ) {
            Text(
                "FURLPAY PROOF-OF-RESERVE",
                style = TextStyle(color = ColorProvider(TextSecondary), fontSize = 10.sp),
            )
            Spacer(modifier = GlanceModifier.height(6.dp))
            Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = if (snap.backingRatio >= 0.0) "%.2f%%".format(snap.backingRatio) else "--",
                    style = TextStyle(
                        color = ColorProvider(if (snap.backingRatio >= 0.0) tierColor else TextPrimary),
                        fontSize = 22.sp,
                        fontFamily = FontFamily.Monospace,
                    ),
                    modifier = GlanceModifier.defaultWeight(),
                )
                if (tier != PorTier.NO_DATA) {
                    Box(
                        modifier = GlanceModifier.background(ColorProvider(tierColor.copy(alpha = 0.16f)))
                            .padding(horizontal = 8.dp, vertical = 3.dp),
                    ) {
                        Text(tier.label, style = TextStyle(color = ColorProvider(tierColor), fontSize = 10.sp))
                    }
                }
            }
            Spacer(modifier = GlanceModifier.height(8.dp))
            Text(
                when {
                    snap.backingRatio < 0.0 -> "Awaiting first attestation…"
                    else -> "Evidence age: ${snap.evidenceAgeMinutes}m · Acurast TEE 3-of-5"
                },
                style = TextStyle(color = ColorProvider(TextSecondary), fontSize = 10.sp),
            )
            Spacer(modifier = GlanceModifier.height(6.dp))
            Text(
                "Soroban M-of-N threshold · zero rehypothecation",
                style = TextStyle(color = ColorProvider(Accent), fontSize = 9.sp),
            )
        }
    }
}

class PorSolvencyWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PorSolvencyWidget()
}
