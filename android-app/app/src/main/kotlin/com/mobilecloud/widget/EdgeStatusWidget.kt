package com.mobilecloud.widget

import android.content.Context
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Column
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.mobilecloud.core.BatteryTelemetry
import com.mobilecloud.core.TelemetryProvider
import com.mobilecloud.ui.theme.Background
import com.mobilecloud.ui.theme.TextPrimary
import com.mobilecloud.ui.theme.TextSecondary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

/** Samples the phone on widget updates only. These readings do not imply node health. */
class EdgeStatusWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val (temp, battery) = withContext(Dispatchers.IO) {
            TelemetryProvider.readBestSocTemp().first to BatteryTelemetry.probe(context).batteryPercent
        }
        val observedAt = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date())
        val tempText = temp?.let { "%.1f °C".format(it) } ?: "unavailable"
        val batteryText = battery?.let { "$it%" } ?: "unavailable"

        provideContent {
            val secondary = TextStyle(color = ColorProvider(TextSecondary), fontSize = 11.sp)
            Column(GlanceModifier.fillMaxSize().background(ColorProvider(Background)).padding(10.dp)) {
                Text("DEVICE TELEMETRY", style = TextStyle(
                    color = ColorProvider(TextPrimary), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                ))
                Spacer(GlanceModifier.height(4.dp))
                Text("SoC: $tempText", style = secondary)
                Text("Battery: $batteryText", style = secondary)
                Text("Sample: $observedAt", style = secondary)
                Text("Local node not included", style = secondary)
            }
        }
    }
}

class EdgeStatusWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = EdgeStatusWidget()
}
