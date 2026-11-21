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
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.text.FontFamily
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.mobilecloud.ui.theme.Accent
import com.mobilecloud.ui.theme.Background
import com.mobilecloud.ui.theme.Critical
import com.mobilecloud.ui.theme.Primary
import com.mobilecloud.ui.theme.Success
import com.mobilecloud.ui.theme.SurfaceElevated
import com.mobilecloud.ui.theme.TextPrimary
import com.mobilecloud.ui.theme.TextSecondary
import com.mobilecloud.ui.theme.Warning

/**
 * Home-screen widget #1: Edge Node Status (GitHub Contributions-widget slot).
 *
 * Glance/Compose widget over the CIDS OLED baseline, refreshed by
 * [com.mobilecloud.work.TelemetryWorker] every 15 minutes — SoC thermal,
 * USB-PD bypass state, battery reserve and mesh peer count.
 */
class EdgeStatusWidget : GlanceAppWidget() {

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snap = WidgetStateStore.snapshot(context)
        provideContent {
            GlanceTheme {
                EdgeStatusContent(snap)
            }
        }
    }

    @Composable
    private fun EdgeStatusContent(snap: WidgetSnapshot) {
        val online = snap.isNodeOnline()
        val statusText = if (online) "● ONLINE" else "● STALE"
        val statusColor = if (online) Success else Warning
        val tempText = if (snap.socTempC >= 0.0) "%.1f °C".format(snap.socTempC) else "--"
        val tempColor = when {
            snap.socTempC > 45.0 -> Critical
            snap.socTempC > 41.0 -> Warning
            else -> Success
        }

        Column(
            modifier = GlanceModifier.fillMaxSize().background(ColorProvider(Background)).padding(10.dp),
            verticalAlignment = Alignment.Vertical.Top,
        ) {
            Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "MOBILECLOUD EDGE NODE",
                    style = TextStyle(color = ColorProvider(TextPrimary), fontSize = 11.sp, fontWeight = FontWeight.Bold),
                    modifier = GlanceModifier.defaultWeight(),
                )
                Text(statusText, style = TextStyle(color = ColorProvider(statusColor), fontSize = 11.sp))
            }
            Spacer(modifier = GlanceModifier.fillMaxWidth().height(1.dp).background(ColorProvider(SurfaceElevated)))
            Spacer(modifier = GlanceModifier.height(8.dp))

            Row(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("SOC TEMP", style = TextStyle(color = ColorProvider(TextSecondary), fontSize = 10.sp), modifier = GlanceModifier.defaultWeight())
                Text(tempText, style = TextStyle(color = ColorProvider(tempColor), fontSize = 12.sp, fontFamily = FontFamily.Monospace))
            }
            Row(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("POWER", style = TextStyle(color = ColorProvider(TextSecondary), fontSize = 10.sp), modifier = GlanceModifier.defaultWeight())
                Text(
                    if (snap.bypassActive) "BYPASS (0 mA)" else "CELL ${snap.batteryPercent}%",
                    style = TextStyle(color = ColorProvider(if (snap.bypassActive) Success else Primary), fontSize = 12.sp, fontFamily = FontFamily.Monospace),
                )
            }
            Row(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("MESH PEERS", style = TextStyle(color = ColorProvider(TextSecondary), fontSize = 10.sp), modifier = GlanceModifier.defaultWeight())
                Text("${snap.meshPeers} ACTIVE", style = TextStyle(color = ColorProvider(Accent), fontSize = 12.sp, fontFamily = FontFamily.Monospace))
            }
        }
    }
}

class EdgeStatusWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = EdgeStatusWidget()
}
