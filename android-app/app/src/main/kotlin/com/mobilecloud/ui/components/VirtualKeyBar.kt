package com.mobilecloud.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.terminal.KeyModifiers
import com.mobilecloud.terminal.TerminalKey
import com.mobilecloud.ui.theme.AppFonts
import com.mobilecloud.ui.theme.Aurora

/**
 * Declarative description of one accessory key. Layouts are data so callers can
 * swap in a vim/emacs/tmux-specific palette without forking the component.
 */
sealed interface VirtualKeySpec {
    val label: String

    /**
     * Printable text; [value] lets a key show `^C` while sending 0x03.
     * [alt] is the "popup" character emitted when the key is swiped upward,
     * following Termux's extra-keys convention.
     */
    data class Text(
        override val label: String,
        val value: String = label,
        val alt: String? = null,
    ) : VirtualKeySpec

    /** A named key encoded by [com.mobilecloud.terminal.TerminalKeyEncoder]. */
    data class Named(override val label: String, val key: TerminalKey) : VirtualKeySpec

    /** Sticky modifier; applies to the next key press, then clears. */
    data class Modifier(override val label: String, val modifier: TerminalModifier) : VirtualKeySpec
}

enum class TerminalModifier { CTRL, ALT, SHIFT }

/**
 * Touch-optimized two-row accessory bar (master blueprint §3 Screen 3;
 * terminal doc §1.1) — the developer-critical keys omitted from soft
 * keyboards, laid out like Termux's extra-keys row.
 *
 * CTRL / ALT / SHIFT are sticky: armed once, applied to the next key, then
 * automatically disarmed. Multiple modifiers can be armed together
 * (Ctrl+Alt+arrow) and are released after a single emission.
 */
@Composable
fun VirtualKeyBar(
    onKey: (String) -> Unit,
    onNamed: (TerminalKey, KeyModifiers) -> Unit,
    modifier: Modifier = Modifier,
    rows: List<List<VirtualKeySpec>> = StandardKeyRows,
) {
    var ctrlArmed by remember { mutableStateOf(false) }
    var altArmed by remember { mutableStateOf(false) }
    var shiftArmed by remember { mutableStateOf(false) }

    fun modifiers() = KeyModifiers(ctrl = ctrlArmed, alt = altArmed, shift = shiftArmed)

    fun resetModifiers() {
        ctrlArmed = false
        altArmed = false
        shiftArmed = false
    }

    fun emitText(spec: VirtualKeySpec.Text) {
        onKey(modifiers().applyToText(spec.value))
        resetModifiers()
    }

    fun emitNamed(spec: VirtualKeySpec.Named) {
        onNamed(spec.key, modifiers())
        resetModifiers()
    }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        rows.forEach { row ->
            Row(
                modifier = Modifier
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                row.forEach { spec ->
                    when (spec) {
                        is VirtualKeySpec.Modifier -> KeyCap(
                            label = spec.label,
                            armed = when (spec.modifier) {
                                TerminalModifier.CTRL -> ctrlArmed
                                TerminalModifier.ALT -> altArmed
                                TerminalModifier.SHIFT -> shiftArmed
                            },
                            onClick = {
                                when (spec.modifier) {
                                    TerminalModifier.CTRL -> ctrlArmed = !ctrlArmed
                                    TerminalModifier.ALT -> altArmed = !altArmed
                                    TerminalModifier.SHIFT -> shiftArmed = !shiftArmed
                                }
                            },
                        )
                        is VirtualKeySpec.Text -> KeyCap(
                            label = spec.label,
                            onClick = { emitText(spec) },
                            onAlt = spec.alt?.let { alt ->
                                {
                                    onKey(modifiers().applyToText(alt))
                                    resetModifiers()
                                }
                            },
                        )
                        is VirtualKeySpec.Named -> KeyCap(
                            label = spec.label,
                            onClick = { emitNamed(spec) },
                        )
                    }
                }
            }
        }
    }
}

/** Default Termux-grade layout: modifiers + shell punctuation, then navigation. */
val StandardKeyRows: List<List<VirtualKeySpec>> = listOf(
    listOf(
        VirtualKeySpec.Modifier("CTRL", TerminalModifier.CTRL),
        VirtualKeySpec.Modifier("ALT", TerminalModifier.ALT),
        VirtualKeySpec.Modifier("SHIFT", TerminalModifier.SHIFT),
        VirtualKeySpec.Named("ESC", TerminalKey.ESC),
        VirtualKeySpec.Named("TAB", TerminalKey.TAB),
        VirtualKeySpec.Text("/", alt = "\\"),
        VirtualKeySpec.Text("-"),
        VirtualKeySpec.Text("|", alt = "&"),
        VirtualKeySpec.Text("~"),
        VirtualKeySpec.Text("`"),
        VirtualKeySpec.Text("$"),
        VirtualKeySpec.Text("&"),
        VirtualKeySpec.Text("_"),
    ),
    listOf(
        VirtualKeySpec.Named("HOME", TerminalKey.HOME),
        VirtualKeySpec.Named("END", TerminalKey.END),
        VirtualKeySpec.Named("PGUP", TerminalKey.PAGE_UP),
        VirtualKeySpec.Named("PGDN", TerminalKey.PAGE_DOWN),
        VirtualKeySpec.Named("◀", TerminalKey.LEFT),
        VirtualKeySpec.Named("▲", TerminalKey.UP),
        VirtualKeySpec.Named("▼", TerminalKey.DOWN),
        VirtualKeySpec.Named("▶", TerminalKey.RIGHT),
        VirtualKeySpec.Text("^C", "\u0003"),
        VirtualKeySpec.Text("^D", "\u0004"),
        VirtualKeySpec.Text("^Z", "\u001a"),
        VirtualKeySpec.Text("^L", "\u000c"),
        VirtualKeySpec.Text("^R", "\u0012"),
    ),
)

@Composable
private fun KeyCap(
    label: String,
    armed: Boolean = false,
    onClick: () -> Unit,
    onAlt: (() -> Unit)? = null,
) {
    val shape = RoundedCornerShape(6.dp)
    Box(
        modifier = Modifier
            .height(32.dp)
            .clip(shape)
            .background(if (armed) Aurora.Cyan.copy(alpha = 0.22f) else Aurora.CardAlt)
            .border(
                width = 1.dp,
                color = if (armed) Aurora.Cyan else Aurora.Border,
                shape = shape,
            )
            // Swipe up emits the popup character. A vertical drag past touch
            // slop wins over the tap detector, so a tap still emits the base
            // key while an upward flick emits its alternate.
            .pointerInput(onAlt) {
                if (onAlt == null) return@pointerInput
                var fired = false
                detectVerticalDragGestures(
                    onDragStart = { fired = false },
                    onVerticalDrag = { change, dragAmount ->
                        if (dragAmount < 0f) fired = true
                        change.consume()
                    },
                    onDragEnd = { if (fired) onAlt() },
                )
            }
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (armed) "$label•" else label,
            color = if (armed) Aurora.Cyan else Aurora.TextHi,
            fontSize = 11.sp,
            fontWeight = if (armed) FontWeight.Bold else FontWeight.Medium,
            fontFamily = AppFonts.Mono,
        )
    }
}
