package com.mobilecloud.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.ui.theme.badgeColors

/**
 * Five-tier health badge (master blueprint §3 Screen 4) rendered with the
 * GitHub badge spec (decompilation report §20.2.6): background at 16% alpha,
 * label in the accent hue, and a 1dp stroke at 32% alpha.
 *
 * HEALTHY (green)  — reserves >= 100.00%, evidence age < 2h
 * WARNING (yellow) — backing 99.50%–99.99% or T+1 transit active
 * STALE   (orange) — source data > 4h old
 * CRITICAL (red)   — confirmed deficit (< 99.50%)
 * FROZEN  (purple) — contractually paused by issuer governance
 */
enum class TierStatus(val label: String, val color: Color) {
    HEALTHY("HEALTHY", Color(0xFF22C55E)),
    WARNING("WARNING", Color(0xFFEAB308)),
    STALE("STALE", Color(0xFFF97316)),
    CRITICAL("CRITICAL", Color(0xFFEF4444)),
    FROZEN("FROZEN", Color(0xFFA855F7)),
    UNKNOWN("UNKNOWN", Color(0xFF64748B)),
}

@Composable
fun StatusBadge(tier: TierStatus, modifier: Modifier = Modifier) {
    val colors = badgeColors(tier.color)
    Box(
        modifier = modifier
            .background(colors.background, RoundedCornerShape(6.dp))
            .border(1.dp, colors.stroke, RoundedCornerShape(6.dp))
            .padding(horizontal = 10.dp, vertical = 4.dp)
    ) {
        Text(
            text = tier.label,
            color = colors.label,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.8.sp,
        )
    }
}

/**
 * Generic accent-chip for non-tier states (trade status, venue tags, mesh
 * roles) — same 3-token spec, driven by an arbitrary accent color.
 */
@Composable
fun AccentBadge(label: String, accent: Color, modifier: Modifier = Modifier) {
    val colors = badgeColors(accent)
    Box(
        modifier = modifier
            .background(colors.background, RoundedCornerShape(6.dp))
            .border(1.dp, colors.stroke, RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp)
    ) {
        Text(
            text = label,
            color = colors.label,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.5.sp,
        )
    }
}

/** Metric card row label + value used across the screens. */
@Composable
fun MetricRow(label: String, value: String, accent: Color = MaterialTheme.colorScheme.primary) {
    Row(
        modifier = Modifier.padding(vertical = 2.dp)
    ) {
        Text(
            label,
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
        Text(value, fontSize = 13.sp, color = accent, fontWeight = FontWeight.Medium)
    }
}
