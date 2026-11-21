package com.mobilecloud.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.core.OperatingMode
import com.mobilecloud.ui.theme.Accent
import com.mobilecloud.ui.theme.Background
import com.mobilecloud.ui.theme.Critical
import com.mobilecloud.ui.theme.Success
import com.mobilecloud.ui.theme.Surface
import com.mobilecloud.ui.theme.TextSecondary
import com.mobilecloud.ui.theme.Warning

/**
 * Operating-mode banner (audit prompt Phase 9/11): rendered at the top of
 * every data screen so SIMULATION data can never be mistaken for LIVE
 * operations. Mode is persisted and never switches silently.
 */
@Composable
fun ModeBanner(mode: OperatingMode, detail: String, modifier: Modifier = Modifier) {
    val (labelColor, bg) = when (mode) {
        OperatingMode.LIVE -> Success to Surface
        OperatingMode.SIMULATION -> Warning to Surface
        OperatingMode.DEGRADED -> Critical to Surface
    }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(bg.copy(alpha = 0.35f), RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp)
    ) {
        Row {
            Text(
                "MODE: ",
                color = TextSecondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                mode.label,
                color = labelColor, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
        Text(detail, color = TextSecondary, fontSize = 11.sp)
    }
}

/** Per-metric provenance chip — where each displayed value comes from. */
@Composable
fun ProvenanceChip(source: String, modifier: Modifier = Modifier) {
    Text(
        "src: $source",
        color = Accent,
        fontSize = 9.sp,
        fontFamily = FontFamily.Monospace,
        modifier = modifier
            .background(Accent.copy(alpha = 0.12f), RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}
