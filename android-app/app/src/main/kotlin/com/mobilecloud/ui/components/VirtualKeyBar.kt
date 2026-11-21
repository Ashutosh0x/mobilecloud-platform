package com.mobilecloud.ui.components

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Touch-optimized virtual key bar (master blueprint §3 Screen 3; terminal
 * doc 1.1) — the developer-critical keys omitted from soft keyboards.
 *
 * CTRL/ALT are sticky modifiers: armed once, applied to the next keystroke.
 */
@Composable
fun VirtualKeyBar(
    onKey: (String) -> Unit,
    onSpecial: (SpecialKey) -> Unit,
    modifier: Modifier = Modifier,
) {
    var ctrlArmed by remember { mutableStateOf(false) }
    var altArmed by remember { mutableStateOf(false) }

    fun emitControl(char: String) {
        when {
            ctrlArmed -> {
                // CTRL+x → control byte (x & 0x1F).
                onSpecial(SpecialKey.CtrlChar(char.first()))
                ctrlArmed = false
            }
            altArmed -> {
                onSpecial(SpecialKey.AltChar(char.first()))
                altArmed = false
            }
            else -> onKey(char)
        }
    }

    Row(
        modifier = modifier
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 4.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ToggleKey("CTRL", ctrlArmed) { ctrlArmed = !ctrlArmed; if (ctrlArmed) altArmed = false }
        ToggleKey("ALT", altArmed) { altArmed = !altArmed; if (altArmed) ctrlArmed = false }
        PlainKey("ESC") { onSpecial(SpecialKey.Esc) }
        PlainKey("TAB") { onSpecial(SpecialKey.Tab) }
        PlainKey("|") { emitControl("|") }
        PlainKey("~") { emitControl("~") }
        PlainKey("`") { emitControl("`") }
        PlainKey("/") { emitControl("/") }
        PlainKey("-") { emitControl("-") }
        PlainKey("▲") { onSpecial(SpecialKey.Up) }
        PlainKey("▼") { onSpecial(SpecialKey.Down) }
        PlainKey("◀") { onSpecial(SpecialKey.Left) }
        PlainKey("▶") { onSpecial(SpecialKey.Right) }
    }
}

/** Sticky modifier key with armed highlighting. */
@Composable
private fun ToggleKey(label: String, armed: Boolean, onToggle: () -> Unit) {
    OutlinedButton(
        onClick = onToggle,
        modifier = Modifier.padding(0.dp),
        colors = if (armed) {
            androidx.compose.material3.ButtonDefaults.outlinedButtonColors(
                containerColor = androidx.compose.ui.graphics.Color(0xFF38BDF8).copy(alpha = 0.2f)
            )
        } else {
            androidx.compose.material3.ButtonDefaults.outlinedButtonColors()
        },
    ) {
        Text(if (armed) "$label*" else label, fontSize = 12.sp)
    }
}

@Composable
private fun PlainKey(label: String, onEmit: () -> Unit) {
    OutlinedButton(onClick = onEmit) { Text(label, fontSize = 12.sp) }
}

/** Non-printable key emissions from the virtual bar. */
sealed interface SpecialKey {
    data object Esc : SpecialKey
    data object Tab : SpecialKey
    data object Up : SpecialKey
    data object Down : SpecialKey
    data object Left : SpecialKey
    data object Right : SpecialKey
    data class CtrlChar(val ch: Char) : SpecialKey
    data class AltChar(val ch: Char) : SpecialKey
}
