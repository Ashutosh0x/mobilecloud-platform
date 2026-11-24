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
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.mobilecloud.ui.theme.Background
import com.mobilecloud.ui.theme.TextSecondary
import com.mobilecloud.ui.theme.Warning

/** This client has no verifier for signed evidence, its freshness, or quorum. */
class PorSolvencyWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val secondary = TextStyle(color = ColorProvider(TextSecondary), fontSize = 11.sp)
            Column(GlanceModifier.fillMaxSize().background(ColorProvider(Background)).padding(10.dp)) {
                Text("PROOF OF RESERVES", style = secondary)
                Spacer(GlanceModifier.height(4.dp))
                Text("Unverified", style = TextStyle(color = ColorProvider(Warning), fontSize = 18.sp))
                Spacer(GlanceModifier.height(4.dp))
                Text("This widget cannot verify reserve evidence. Do not rely on it for financial decisions.", style = secondary)
            }
        }
    }
}

class PorSolvencyWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PorSolvencyWidget()
}
