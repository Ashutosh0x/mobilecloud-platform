package com.mobilecloud.ui.console

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.console.Fmt
import com.mobilecloud.ui.theme.AppFonts
import com.mobilecloud.ui.theme.Aurora

/* =========================================================================
 * CONSOLE UI KIT — 1:1 visual port of the web `globals.css` primitives:
 * panel, primary/ghost/danger buttons, fields, badges, range tabs, tables,
 * toggles, notices and the toast. Every colour maps to a `--token`.
 * ========================================================================= */

/** Semantic tone → colour, matching the web `.badge` variants. */
enum class Tone { OK, WARN, BAD, INFO, NEUTRAL }

fun toneColor(tone: Tone): Color = when (tone) {
    Tone.OK -> Aurora.GlowGreen
    Tone.WARN -> Aurora.Amber
    Tone.BAD -> Aurora.Red
    Tone.INFO -> Aurora.Cyan
    Tone.NEUTRAL -> Aurora.TextMid
}

/** Maps a deployment / build / domain status string to a badge tone (web `.badge`). */
fun statusTone(status: String): Tone = when (status.lowercase()) {
    "ready", "live", "ok", "active", "online", "succeeded", "success", "enabled" -> Tone.OK
    "warn", "warning", "building", "pending", "paused", "queued", "degraded", "running" -> Tone.WARN
    "error", "failed", "halted", "disabled", "denied", "blocked", "offline" -> Tone.BAD
    "info" -> Tone.INFO
    else -> Tone.NEUTRAL
}

/* ------------------------------- Text ---------------------------------- */

@Composable
fun Mono(text: String, color: Color = Aurora.TextHi, size: Int = 13, weight: FontWeight = FontWeight.Normal, maxLines: Int = 1) {
    Text(
        text, color = color, fontSize = size.sp, fontFamily = AppFonts.Mono,
        fontWeight = weight, maxLines = maxLines,
    )
}

@Composable
fun Hint(text: String, modifier: Modifier = Modifier) {
    Text(text, color = Aurora.TextMid, fontSize = 12.sp, modifier = modifier)
}

/* ------------------------------- Panel --------------------------------- */

/** `.panel` — dark card with a border; optional head with title/sub/actions. */
@Composable
fun CPanel(
    modifier: Modifier = Modifier,
    title: String? = null,
    subtitle: String? = null,
    actions: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Aurora.Card)
            .border(1.dp, Aurora.Border, RoundedCornerShape(12.dp))
            .padding(16.dp),
    ) {
        if (title != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(title, color = Aurora.TextHi, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    if (subtitle != null) {
                        Spacer(Modifier.height(3.dp))
                        Text(subtitle, color = Aurora.TextMid, fontSize = 12.sp)
                    }
                }
                if (actions != null) actions()
            }
            Spacer(Modifier.height(14.dp))
        }
        content()
    }
}

/** Page title block shown at the top of every route (web `.welcome` + `.crumb`). */
@Composable
fun PageHead(title: String, description: String? = null, actions: (@Composable () -> Unit)? = null) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f)) {
            Text(title, color = Aurora.TextHi, fontSize = 20.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp)
            if (description != null) {
                Spacer(Modifier.height(3.dp))
                Text(description, color = Aurora.TextMid, fontSize = 12.sp)
            }
        }
        if (actions != null) actions()
    }
}

/* ------------------------------ Buttons -------------------------------- */

enum class BtnKind { PRIMARY, GHOST, DANGER }

@Composable
fun CButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: BtnKind = BtnKind.PRIMARY,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    loading: Boolean = false,
    compact: Boolean = false,
) {
    val container = when (kind) {
        BtnKind.PRIMARY -> Aurora.Cyan
        BtnKind.DANGER -> Aurora.Red
        BtnKind.GHOST -> Color.Transparent
    }
    val borderC = if (kind == BtnKind.GHOST) Aurora.Border else container
    val fg = when (kind) {
        BtnKind.GHOST -> Aurora.TextHi
        else -> Color.White
    }
    val shape = RoundedCornerShape(8.dp)
    Row(
        modifier
            .clip(shape)
            .background(if (enabled) container else Aurora.Track)
            .border(1.dp, if (enabled) borderC else Aurora.Border, shape)
            .clickable(enabled = enabled && !loading) { onClick() }
            .padding(horizontal = if (compact) 10.dp else 14.dp, vertical = if (compact) 6.dp else 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(color = fg, strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(7.dp))
        } else if (icon != null) {
            Icon(icon, contentDescription = null, tint = if (enabled) fg else Aurora.TextLow, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(7.dp))
        }
        Text(
            text,
            color = if (enabled) fg else Aurora.TextLow,
            fontSize = if (compact) 12.sp else 13.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/* ------------------------------- Badge --------------------------------- */

/** `.badge` — small tinted pill with a leading dot. */
@Composable
fun CBadge(text: String, tone: Tone = Tone.NEUTRAL, modifier: Modifier = Modifier) {
    val c = toneColor(tone)
    Row(
        modifier
            .clip(RoundedCornerShape(999.dp))
            .background(c.copy(alpha = 0.12f))
            .border(1.dp, c.copy(alpha = 0.32f), RoundedCornerShape(999.dp))
            .padding(horizontal = 8.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(5.dp).background(c, CircleShape))
        Spacer(Modifier.width(6.dp))
        Text(text.ifEmpty { "—" }, color = c, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** Neutral mono chip for ids / routes / hosts. */
@Composable
fun CChip(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        color = Aurora.TextHi,
        fontSize = 11.sp,
        fontFamily = AppFonts.Mono,
        maxLines = 1,
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(Aurora.CardAlt)
            .border(1.dp, Aurora.Border, RoundedCornerShape(6.dp))
            .padding(horizontal = 7.dp, vertical = 2.dp),
    )
}

/* ------------------------------- Field --------------------------------- */

/** `.field` — labelled input with the `--card-well` inset surface. */
@Composable
fun CField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    mono: Boolean = false,
    password: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    singleLine: Boolean = true,
    minHeight: Int = 44,
) {
    Column(modifier.fillMaxWidth()) {
        Text(label, color = Aurora.TextMid, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.height(5.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(Aurora.CardWell)
                .border(1.dp, Aurora.Border, RoundedCornerShape(8.dp))
                .padding(horizontal = 11.dp, vertical = 11.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = singleLine,
                textStyle = TextStyle(
                    color = Aurora.TextHi,
                    fontSize = 13.sp,
                    fontFamily = if (mono) AppFonts.Mono else AppFonts.Sans,
                ),
                cursorBrush = SolidColor(Aurora.Cyan),
                keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else keyboardType),
                visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
                modifier = Modifier.fillMaxWidth().height(if (singleLine) 20.dp else minHeight.dp),
                decorationBox = { inner ->
                    if (value.isEmpty()) Text(placeholder, color = Aurora.TextLow, fontSize = 13.sp)
                    inner()
                },
            )
        }
    }
}

/* ------------------------------- Toggle -------------------------------- */

/** `.toggle` — web-styled switch. */
@Composable
fun CToggle(checked: Boolean, onCheckedChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val track = if (checked) Aurora.Cyan else Aurora.Track
    Box(
        modifier
            .size(width = 40.dp, height = 22.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(track)
            .border(1.dp, if (checked) Aurora.Cyan else Aurora.Border, RoundedCornerShape(999.dp))
            .clickable { onCheckedChange(!checked) },
        contentAlignment = if (checked) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        Box(
            Modifier
                .padding(horizontal = 3.dp)
                .size(15.dp)
                .background(if (checked) Color.White else Aurora.TextMid, CircleShape)
        )
    }
}

/** Row with a label/sub on the left and a toggle on the right. */
@Composable
fun CToggleRow(
    title: String,
    subtitle: String? = null,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            if (subtitle != null) {
                Spacer(Modifier.height(2.dp))
                Text(subtitle, color = Aurora.TextMid, fontSize = 11.sp)
            }
        }
        CToggle(checked, onCheckedChange)
    }
}

/* ----------------------------- Range tabs ------------------------------ */

/** `.ranges` / `.seg` — segmented control used by the charts. */
@Composable
fun RangeTabs(
    options: List<String>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .clip(RoundedCornerShape(8.dp))
            .background(Aurora.CardWell)
            .border(1.dp, Aurora.Border, RoundedCornerShape(8.dp))
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        options.forEach { option ->
            val on = option == selected
            Text(
                option,
                color = if (on) Color.White else Aurora.TextMid,
                fontSize = 11.sp,
                fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(if (on) Aurora.Cyan else Color.Transparent)
                    .clickable { onSelect(option) }
                    .padding(horizontal = 10.dp, vertical = 5.dp),
            )
        }
    }
}

/* ------------------------------ Tables --------------------------------- */

/** Table header row (web `.table th`). */
@Composable
fun CTableHead(columns: List<String>, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        columns.forEachIndexed { i, col ->
            Text(
                col.uppercase(),
                color = Aurora.TextLow,
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.6.sp,
                maxLines = 1,
                modifier = Modifier.weight(if (i == 0) 1.5f else 1f),
            )
        }
    }
}

/** A table row (web `.table tr`) separated by a `--divider` hairline. */
@Composable
fun CRow(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Aurora.Divider))
        Box(Modifier.fillMaxWidth().padding(vertical = 10.dp)) { content() }
    }
}

/* ------------------------- Empty / notice / toast ---------------------- */

/** `.empty` — muted placeholder text. */
@Composable
fun CEmpty(text: String, modifier: Modifier = Modifier) {
    Text(text, color = Aurora.TextLow, fontSize = 12.sp, modifier = modifier.padding(vertical = 10.dp))
}

/** `.banner` — full-width inline alert. */
@Composable
fun CNotice(text: String, tone: Tone = Tone.INFO, modifier: Modifier = Modifier) {
    val c = toneColor(tone)
    Text(
        text,
        color = c,
        fontSize = 12.sp,
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(c.copy(alpha = 0.10f))
            .border(1.dp, c.copy(alpha = 0.30f), RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 9.dp),
    )
}

/* ------------------------------- Stats --------------------------------- */

/** `.stat` — big figure with an uppercase caption and optional hint. */
@Composable
fun CStat(
    label: String,
    value: String,
    hint: String? = null,
    chip: (@Composable () -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Aurora.Card)
            .border(1.dp, Aurora.Border, RoundedCornerShape(12.dp))
            .padding(14.dp),
    ) {
        Text(
            value,
            color = Aurora.TextHi,
            fontSize = 19.sp,
            fontWeight = FontWeight.SemiBold,
            fontFamily = AppFonts.Mono,
            letterSpacing = (-0.5).sp,
            maxLines = 1,
        )
        Spacer(Modifier.height(4.dp))
        Text(label.uppercase(), color = Aurora.TextLow, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp)
        if (hint != null) {
            Spacer(Modifier.height(5.dp))
            Text(hint, color = Aurora.TextMid, fontSize = 11.sp)
        }
        if (chip != null) {
            Spacer(Modifier.height(8.dp))
            chip()
        }
    }
}

/* ------------------------------- Charts -------------------------------- */

/** Web `.chart-wrap` SVG bar chart — 240×80 viewBox, `#3B82F6` bars. */
@Composable
fun BarChart(
    counts: List<Int>,
    modifier: Modifier = Modifier,
    color: Color = Color(0xFF3B82F6),
) {
    androidx.compose.foundation.Canvas(modifier) {
        if (counts.isEmpty()) return@Canvas
        val max = counts.max().coerceAtLeast(1)
        val slot = size.width / counts.size
        val pad = 1.dp.toPx()
        counts.forEachIndexed { i, c ->
            val h = (c.toFloat() / max) * size.height
            val w = (slot - pad * 2).coerceAtLeast(2.dp.toPx())
            drawRect(
                color = color,
                topLeft = Offset(i * slot + pad, size.height - h),
                size = Size(w, h),
            )
        }
    }
}

/** Web `.hours` — a row of thin vertical bars for per-hour traffic. */
@Composable
fun HourBars(counts: List<Int>, modifier: Modifier = Modifier, color: Color = Aurora.Cyan) {
    val peak = counts.maxOrNull()?.coerceAtLeast(1) ?: 1
    androidx.compose.foundation.Canvas(modifier) {
        if (counts.isEmpty()) return@Canvas
        val slot = size.width / counts.size
        val w = (slot * 0.5f).coerceAtLeast(1.5f)
        counts.forEachIndexed { i, c ->
            val h = (kotlin.math.max(4f, (c.toFloat() / peak) * size.height))
            drawRect(color, topLeft = Offset(i * slot, size.height - h), size = Size(w, h))
        }
    }
}

/* ------------------------------- Select -------------------------------- */

/** Web `<select>` — a well-styled trigger that opens a Material dropdown. */
@Composable
fun CSelect(
    options: List<String>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: (String) -> String = { it },
    enabled: Boolean = true,
) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        Row(
            Modifier
                .clip(RoundedCornerShape(8.dp))
                .background(if (enabled) Aurora.CardWell else Aurora.Card)
                .border(1.dp, Aurora.Border, RoundedCornerShape(8.dp))
                .clickable(enabled = enabled) { open = true }
                .padding(horizontal = 11.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label(selected),
                color = if (enabled) Aurora.TextHi else Aurora.TextLow,
                fontSize = 13.sp, maxLines = 1,
                modifier = Modifier.weight(1f),
            )
            Text("▾", color = Aurora.TextMid, fontSize = 11.sp)
        }
        androidx.compose.material3.DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { option ->
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(label(option), color = Aurora.TextHi, fontSize = 13.sp) },
                    onClick = { open = false; onSelect(option) },
                )
            }
        }
    }
}

/* ------------------------------- Modal --------------------------------- */

/** `.modal-back` + `.modal` — centred dialog with a scrim (used by Confirm). */
@Composable
fun CModal(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    Box(
        Modifier.fillMaxWidth().fillMaxSize().background(Color(0xCC000000))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onDismiss() },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .padding(24.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(Aurora.CardAlt)
                .border(1.dp, Aurora.Border, RoundedCornerShape(14.dp))
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {}
                .padding(18.dp),
        ) { content() }
    }
}

/** `.modal` confirm dialog with Cancel / Confirm. */
@Composable
fun ConfirmDialog(
    title: String,
    body: String,
    confirmText: String = "Confirm",
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
) {
    CModal(onDismiss = onCancel) {
        Column {
            Text(title, color = Aurora.TextHi, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            Text(body, color = Aurora.TextMid, fontSize = 12.sp)
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CButton("Cancel", onClick = onCancel, kind = BtnKind.GHOST)
                CButton(confirmText, onClick = onConfirm, kind = BtnKind.DANGER)
            }
        }
    }
}

/** Relative time string (web `ClientTime`). */
fun ctime(ts: Long): String = Fmt.rel(ts)

/** `.meter` — labelled progress row (CPU / Memory / Disk). */
@Composable
fun CMeterRow(label: String, valueText: String, pct: Float, color: Color = Aurora.Cyan) {
    Column(Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = Aurora.TextMid, fontSize = 12.sp, modifier = Modifier.weight(1f))
            Mono(valueText, color = Aurora.TextHi, size = 12, weight = FontWeight.SemiBold)
        }
        Spacer(Modifier.height(6.dp))
        Box(
            Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(999.dp)).background(Aurora.Track)
        ) {
            Box(
                Modifier
                    .fillMaxWidth(pct.coerceIn(0f, 1f))
                    .height(6.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(color)
            )
        }
    }
}

/** Label/value row used inside panels (web `.list-row`). */
@Composable
fun CListRow(label: String, value: String, valueColor: Color = Aurora.TextHi, mono: Boolean = true) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = Aurora.TextMid, fontSize = 13.sp)
        Text(
            value,
            color = valueColor,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            fontFamily = if (mono) AppFonts.Mono else AppFonts.Sans,
            maxLines = 1,
        )
    }
}

/** Thin divider token for stacked rows. */
@Composable
fun CHairline() {
    Box(Modifier.fillMaxWidth().height(1.dp).background(Aurora.Divider))
}
