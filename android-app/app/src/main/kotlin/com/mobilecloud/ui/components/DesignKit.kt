package com.mobilecloud.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.ui.theme.Aurora
import kotlinx.coroutines.delay

/* =========================================================================
 * AURORA CONSOLE DESIGN KIT
 * Reference-exact shared components for every MobileCloud Node screen:
 * GlowCard, SectionLabel, StatusPill, IconBadge, ProvenanceChip (styled),
 * MetricCard, ProgressRing, LinearMeter, Sparkline, TrafficChart,
 * MeshTopology, DotTickSlider, HoldToConfirmButton.
 * =========================================================================

/**
 * Signature surface: dark card with a soft glowing border (ref8 identity).
 * [glow] picks the border hue; pass [Aurora.Border] for a flat subtle card.
 */
@Composable
fun GlowCard(
    modifier: Modifier = Modifier,
    glow: Color = Aurora.Border,
    glowRadius: Dp = 10.dp,
    corner: Dp = 18.dp,
    background: Color = Aurora.Card,
    content: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(corner)
    Box(
        modifier = modifier
            .drawBehind {
                if (glow != Aurora.Border) {
                    // Soft outer halo behind the card.
                    drawRoundRect(
                        color = glow.copy(alpha = 0.14f),
                        cornerRadius = CornerRadius(corner.toPx(), corner.toPx()),
                        topLeft = Offset(-glowRadius.toPx() * 0.4f, -glowRadius.toPx() * 0.4f),
                        size = Size(size.width + glowRadius.toPx() * 0.8f, size.height + glowRadius.toPx() * 0.8f),
                    )
                }
            }
            .clip(shape)
            .background(
                Brush.verticalGradient(listOf(background, background.copy(alpha = 0.92f)))
            )
            .border(1.dp, glow.copy(alpha = if (glow == Aurora.Border) 0.9f else 0.42f), shape)
            .padding(0.dp)
    ) { content() }
}

/** Uppercase letter-spaced section label (refs: "DEVICE IDENTITY", "RISK CONTROLS…"). */
@Composable
fun SectionLabel(
    text: String,
    color: Color = Aurora.TextLow,
    modifier: Modifier = Modifier,
) {
    Text(
        text,
        color = color,
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 1.4.sp,
        modifier = modifier,
    )
}

/** Pill with leading status dot — "● Online", "● Normal", "Ready", "Building". */
@Composable
fun StatusPill(
    text: String,
    color: Color = Aurora.GreenSoft,
    bg: Color = color.copy(alpha = 0.14f),
    modifier: Modifier = Modifier,
    bold: Boolean = true,
) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(bg)
            .border(1.dp, color.copy(alpha = 0.35f), RoundedCornerShape(999.dp))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(5.dp)
                .background(color, CircleShape)
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text,
            color = color,
            fontSize = 10.sp,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Medium,
            letterSpacing = 0.4.sp,
        )
    }
}

/** Icon inside a tinted rounded-square (refs: metric cards, battery rows). */
@Composable
fun IconBadge(
    icon: ImageVector,
    tint: Color,
    bg: Color = tint.copy(alpha = 0.14f),
    size: Dp = 34.dp,
    iconSize: Dp = 18.dp,
) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(size / 3))
            .background(bg),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(iconSize))
    }
}

/** Reference "src: xxx" provenance chip (blue-bordered mono pill). */
@Composable
fun RefSourceChip(source: String, modifier: Modifier = Modifier) {
    Text(
        "src: $source",
        color = Aurora.ChipText,
        fontSize = 9.sp,
        fontFamily = FontFamily.Monospace,
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .border(1.dp, Aurora.ChipText.copy(alpha = 0.35f), RoundedCornerShape(6.dp))
            .background(Aurora.ChipBg.copy(alpha = 0.55f))
            .padding(horizontal = 7.dp, vertical = 2.dp),
    )
}

/** Compact stat card: icon + label + big value + optional chip (ref8 trio). */
@Composable
fun MetricCard(
    label: String,
    value: String,
    icon: ImageVector,
    accent: Color,
    chip: (@Composable () -> Unit)? = null,
    modifier: Modifier = Modifier,
    meter: Float? = null, // optional 0..1 progress bar under the value
) {
    GlowCard(modifier = modifier, corner = 16.dp) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconBadge(icon, accent, size = 26.dp, iconSize = 15.dp)
                Spacer(Modifier.width(7.dp))
                SectionLabel(label, color = Aurora.TextLow)
            }
            Spacer(Modifier.height(8.dp))
            Text(
                value,
                color = Aurora.TextHi,
                fontSize = 17.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            if (meter != null) {
                Spacer(Modifier.height(7.dp))
                LinearMeter(progress = meter, color = accent)
            }
            if (chip != null) {
                Spacer(Modifier.height(7.dp))
                chip()
            }
        }
    }
}

/** Circular progress ring (ref8 battery 42%, ref1 system health 99.9%). */
@Composable
fun ProgressRing(
    progress: Float,
    color: Color = Aurora.GlowGreen,
    track: Color = Aurora.Track,
    stroke: Dp = 8.dp,
    size: Dp = 96.dp,
    content: @Composable () -> Unit = {},
) {
    val anim by animateFloatAsState(progress, tween(700), label = "ring")
    Box(
        Modifier
            .size(size)
            .drawBehind {
                val s = this.size.minDimension - stroke.toPx()
                val topLeft = Offset((this.size.width - s) / 2f, (this.size.height - s) / 2f)
                drawArc(
                    track, 0f, 360f, false,
                    topLeft = topLeft, size = Size(s, s),
                    style = Stroke(stroke.toPx(), cap = StrokeCap.Round),
                )
                drawArc(
                    Brush.sweepGradient(listOf(color.copy(alpha = 0.55f), color, color.copy(alpha = 0.55f))),
                    -90f, 360f * anim.coerceIn(0f, 1f), false,
                    topLeft = topLeft, size = Size(s, s),
                    style = Stroke(stroke.toPx(), cap = StrokeCap.Round),
                )
            },
        contentAlignment = Alignment.Center,
    ) { content() }
}

/** Rounded linear meter bar. */
@Composable
fun LinearMeter(
    progress: Float,
    color: Color = Aurora.GlowGreen,
    track: Color = Aurora.Track,
    height: Dp = 6.dp,
    modifier: Modifier = Modifier,
) {
    val anim by animateFloatAsState(progress.coerceIn(0f, 1f), tween(600), label = "meter")
    Box(
        modifier
            .fillMaxWidth()
            .height(height)
            .clip(RoundedCornerShape(999.dp))
            .background(track)
    ) {
        Box(
            Modifier
                .fillMaxWidth(anim)
                .fillMaxHeight()
                .clip(RoundedCornerShape(999.dp))
                .background(
                    Brush.horizontalGradient(listOf(color.copy(alpha = 0.65f), color))
                )
        )
    }
}

/** Tiny sparkline (ref1 project rows). */
@Composable
fun Sparkline(
    points: List<Float>,
    color: Color = Aurora.GlowGreen,
    modifier: Modifier = Modifier,
) {
    androidx.compose.foundation.Canvas(modifier) {
        if (points.size < 2) return@Canvas
        val min = points.min(); val max = points.max()
        val range = (max - min).takeIf { it > 1e-6f } ?: 1f
        val step = size.width / (points.size - 1)
        val path = Path()
        points.forEachIndexed { i, v ->
            val x = i * step
            val y = size.height - ((v - min) / range) * size.height * 0.86f - size.height * 0.07f
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        drawPath(path, color, style = Stroke(2.dp.toPx(), cap = StrokeCap.Round))
    }
}

/**
 * Traffic line chart with gradient fill (ref1 "Traffic Overview"):
 * smooth path, area fill fading to transparent, optional highlighted dot.
 */
@Composable
fun TrafficChart(
    series: List<Float>,
    color: Color = Aurora.GlowGreen,
    modifier: Modifier = Modifier,
    dotIndex: Int = -1,
) {
    androidx.compose.foundation.Canvas(modifier) {
        if (series.size < 2) return@Canvas
        val min = 0f
        val max = series.max() * 1.15f
        val step = size.width / (series.size - 1)
        fun y(v: Float) = size.height - (v - min) / (max - min) * size.height * 0.9f - size.height * 0.05f

        val line = Path()
        val area = Path()
        series.forEachIndexed { i, v ->
            val x = i * step
            if (i == 0) { line.moveTo(x, y(v)); area.moveTo(x, size.height); area.lineTo(x, y(v)) }
            else { line.lineTo(x, y(v)); area.lineTo(x, y(v)) }
        }
        area.lineTo(size.width, size.height)
        area.close()
        drawPath(area, Brush.verticalGradient(listOf(color.copy(alpha = 0.28f), Color.Transparent)))
        drawPath(line, color, style = Stroke(2.5.dp.toPx(), cap = StrokeCap.Round))

        // gridlines
        for (i in 1..3) {
            val gy = size.height * i / 4f
            drawLine(Aurora.Border.copy(alpha = 0.5f), Offset(0f, gy), Offset(size.width, gy), 1f)
        }
        if (dotIndex in series.indices) {
            drawCircle(color, 5.dp.toPx(), Offset(dotIndex * step, y(series[dotIndex])))
            drawCircle(Color.White, 2.dp.toPx(), Offset(dotIndex * step, y(series[dotIndex])))
        }
    }
}

/**
 * Hub-and-spoke mesh topology canvas (ref6): glowing center node, dim
 * spokes, satellite peers; optional animated pulse traveling the links.
 */
@Composable
fun MeshTopology(
    modifier: Modifier = Modifier,
    peers: Int = 5,
    centerColor: Color = Aurora.Cyan,
    animate: Boolean = true,
) {
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(animate) {
        while (animate) { delay(80); tick++ }
    }
    androidx.compose.foundation.Canvas(modifier) {
        val c = Offset(size.width / 2f, size.height / 2f)
        val r = size.minDimension * 0.36f
        val angles = List(peers) { (it * (2 * Math.PI / peers) - Math.PI / 2).toFloat() }
        val peerPos = angles.map { Offset(c.x + r * kotlin.math.cos(it), c.y + r * kotlin.math.sin(it)) }

        peerPos.forEachIndexed { i, p ->
            drawLine(
                Color(0xFF3A5A78),
                c, p,
                strokeWidth = 2.dp.toPx(),
                cap = StrokeCap.Round,
            )
            // pulse dot traveling center → peer
            if (animate) {
                val t = ((tick + i * 12) % 60) / 60f
                val px = c.x + (p.x - c.x) * t
                val py = c.y + (p.y - c.y) * t
                drawCircle(centerColor.copy(alpha = 0.9f), 2.5.dp.toPx(), Offset(px, py))
            }
            drawCircle(Color(0xFF5A6B85), 4.dp.toPx(), p)
            drawCircle(Color(0xFF2A3850), 6.dp.toPx(), p, style = Stroke(1.5.dp.toPx()))
        }
        // center node: ring + glow
        drawCircle(centerColor.copy(alpha = 0.16f), 16.dp.toPx(), c)
        drawCircle(Aurora.BgDeep, 9.dp.toPx(), c)
        drawCircle(centerColor, 9.dp.toPx(), c, style = Stroke(2.dp.toPx()))
    }
}

/**
 * Reference slider (ref4 risk controls): pill track with tick dots along it
 * and a capsule thumb. Pure-canvas so it matches the screenshots exactly.
 */
@Composable
fun DotTickSlider(
    value: Float,
    onValueChange: (Float) -> Unit,
    range: ClosedFloatingPointRange<Float>,
    ticks: Int = 11,
    modifier: Modifier = Modifier,
    activeColor: Color = Aurora.Cyan,
) {
    var dragging by remember { mutableStateOf(false) }
    val fraction = ((value - range.start) / (range.endInclusive - range.start)).coerceIn(0f, 1f)

    Box(
        modifier
            .fillMaxWidth()
            .height(56.dp)
            .pointerInput(range) {
                detectDragGestures(
                    onDragStart = { dragging = true },
                    onDragEnd = { dragging = false },
                    onDragCancel = { dragging = false },
                ) { change, _ ->
                    val f = (change.position.x / size.width).coerceIn(0f, 1f)
                    onValueChange(range.start + f * (range.endInclusive - range.start))
                }
            }
    ) {
        androidx.compose.foundation.Canvas(
            Modifier
                .align(Alignment.Center)
                .fillMaxWidth()
                .height(30.dp)
        ) {
            val trackH = 12.dp.toPx()
            val r = CornerRadius(trackH / 2, trackH / 2)
            // full track
            drawRoundRect(Aurora.Track, cornerRadius = r, size = Size(size.width, trackH))
            // active fill
            drawRoundRect(
                Brush.horizontalGradient(listOf(activeColor.copy(alpha = 0.75f), activeColor)),
                cornerRadius = r,
                size = Size(size.width * fraction, trackH),
            )
            // tick dots
            for (i in 0..ticks) {
                val x = size.width * i / ticks
                val on = x <= size.width * fraction
                drawCircle(
                    if (on) Aurora.BgDeep.copy(alpha = 0.85f) else Color(0xFF31405C),
                    radius = 2.dp.toPx(),
                    center = Offset(x, trackH / 2),
                )
            }
            // capsule thumb
            val thumbW = 7.dp.toPx(); val thumbH = 34.dp.toPx()
            drawRoundRect(
                Color.White,
                cornerRadius = CornerRadius(thumbW / 2, thumbW / 2),
                topLeft = Offset(size.width * fraction - thumbW / 2, (size.height - thumbH) / 2f),
                size = Size(thumbW, thumbH),
            )
        }
    }
}

/**
 * Hold-to-confirm button (ref4 emergency halt): fills with white→red progress
 * while held; fires [onConfirm] after [holdMs]. Shows percent while holding.
 */
@Composable
fun HoldToConfirmButton(
    text: String,
    holdingText: (Float) -> String,
    onConfirm: () -> Unit,
    modifier: Modifier = Modifier,
    container: Color = Aurora.Red,
    holdMs: Long = 1500,
    enabled: Boolean = true,
) {
    var progress by remember { mutableFloatStateOf(0f) }
    var held by remember { mutableStateOf(false) }
    LaunchedEffect(held, enabled) {
        if (held && enabled) {
            val stepMs = 40f
            while (progress < 1f) {
                delay(stepMs.toLong())
                progress = (progress + stepMs / holdMs).coerceAtMost(1f)
            }
            onConfirm()
            progress = 0f; held = false
        }
    }
    Box(
        modifier
            .fillMaxWidth()
            .height(56.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(container)
            .pointerInput(enabled) {
                androidx.compose.foundation.gestures.detectTapGestures(
                    onPress = {
                        if (enabled) { held = true }
                        try { awaitRelease() } finally { held = false; if (progress < 1f) progress = 0f }
                    }
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        // fill overlay grows with hold progress
        Box(
            Modifier
                .fillMaxWidth(progress)
                .fillMaxHeight()
                .background(Color.White.copy(alpha = 0.28f))
        )
        Text(
            if (progress > 0f) holdingText(progress) else text,
            color = Color.White,
            fontWeight = FontWeight.Bold,
            fontSize = 15.sp,
            letterSpacing = 0.8.sp,
        )
    }
}

/** Bottom tagline (ref8): "MobileCloud • Secure • Independent". */
@Composable
fun FooterTagline(modifier: Modifier = Modifier) {
    Text(
        "MobileCloud • Secure • Independent",
        color = Aurora.GreenSoft.copy(alpha = 0.8f),
        fontSize = 12.sp,
        letterSpacing = 0.6.sp,
        modifier = modifier,
    )
}

/** Simple titled row used across specimen tables. */
@Composable
fun KVRow(
    label: String,
    value: String,
    valueColor: Color = Aurora.TextHi,
    mono: Boolean = true,
    labelColor: Color = Aurora.TextMid,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 9.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = labelColor, fontSize = 14.sp)
        Text(
            value, color = valueColor, fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
        )
    }
}
