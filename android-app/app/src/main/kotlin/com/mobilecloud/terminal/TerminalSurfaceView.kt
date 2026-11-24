package com.mobilecloud.terminal

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp

/**
 * Compose Canvas ANSI/VT100 engine (master blueprint; terminal doc 1.1).
 *
 * Maintains a rows x cols cell buffer with per-cell 8-bit foreground
 * colors, decodes the common ANSI/CSI subset shells and TUI programs emit
 * (SGR colors 30-37/90-97 + 256-color, cursor motion, line wrap, ED/EL
 * erases, BS/CR/LF/TAB, OSC passthrough), and renders with hardware-
 * accelerated monospace draw calls.
 */
class TerminalEmulator(val cols: Int = 80, val rows: Int = 24) {

    data class Cell(var char: Char = ' ', var color: Int = DEFAULT_FG)

    private val screen = Array(rows) { Array(cols) { Cell() } }
    private var cursorRow = 0
    private var cursorCol = 0
    private var currentFg = DEFAULT_FG
    private var pendingBytes = ByteArray(0)

    /** Feed raw VT bytes; a partial UTF-8 tail is buffered for the next chunk. */
    fun feed(chunk: String) {
        pendingBytes += chunk.toByteArray(Charsets.UTF_8)
        val validLen = longestValidUtf8Prefix(pendingBytes)
        val text = String(pendingBytes, 0, validLen, Charsets.UTF_8)
        pendingBytes = pendingBytes.copyOfRange(validLen, pendingBytes.size)
        process(text)
    }

    /** Length of the longest byte prefix that decodes without truncation. */
    private fun longestValidUtf8Prefix(bytes: ByteArray): Int {
        if (bytes.isEmpty()) return 0
        var i = bytes.size - 1
        var continuations = 0
        while (i >= 0 && continuations < 3) {
            val b = bytes[i].toInt() and 0xFF
            if (b and 0xC0 == 0x80) { continuations++; i--; continue }
            val required = when {
                b and 0x80 == 0x00 -> 0
                b and 0xE0 == 0xC0 -> 1
                b and 0xF0 == 0xE0 -> 2
                b and 0xF8 == 0xF0 -> 3
                else -> return bytes.size // stray continuation: let decoder replace
            }
            return if (required > continuations) i else bytes.size
        }
        return bytes.size
    }

    private fun process(text: String) {
        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                c == ESC -> i = handleEscape(text, i)
                c == '\r' -> cursorCol = 0
                c == '\n' -> {
                    cursorRow++
                    if (cursorRow >= rows) scroll()
                }
                c == '\b' -> cursorCol = (cursorCol - 1).coerceAtLeast(0)
                c == '\t' -> cursorCol = ((cursorCol / 8) + 1) * 8
                c == BEL || c == NUL -> { /* BEL, NUL: ignore */ }
                else -> {
                    if (cursorCol >= cols) {
                        cursorCol = 0
                        cursorRow++
                        if (cursorRow >= rows) scroll()
                    }
                    screen[cursorRow][cursorCol] = Cell(c, currentFg)
                    cursorCol++
                }
            }
            i++
        }
    }

    /** Handle escape sequences starting at index; returns next index. */
    private fun handleEscape(text: String, index: Int): Int {
        if (index + 1 >= text.length) return index + 1
        return when (text[index + 1]) {
            '[' -> handleCsi(text, index + 2)
            ']' -> { // OSC - skip until BEL or ESC-backslash (ST)
                var j = index + 2
                while (j < text.length &&
                    text[j] != BEL &&
                    !(text[j] == ESC && j + 1 < text.length && text[j + 1] == '\\')
                ) j++
                (j + 1).coerceAtMost(text.length)
            }
            else -> index + 2 // two-character sequence
        }
    }

    /** CSI dispatch: cursor motion, SGR, erases. */
    private fun handleCsi(text: String, start: Int): Int {
        var j = start
        val params = StringBuilder()
        while (j < text.length) {
            val c = text[j]
            if (c.isLetter()) break
            params.append(c)
            j++
        }
        if (j >= text.length) return j
        val final = text[j]
        val parsed = params.toString().split(';').map { it.toIntOrNull() ?: 0 }

        when (final) {
            'm' -> currentFg = sgrColor(parsed)
            'H', 'f' -> {
                cursorRow = ((parsed.getOrNull(0) ?: 1) - 1).coerceIn(0, rows - 1)
                cursorCol = ((parsed.getOrNull(1) ?: 1) - 1).coerceIn(0, cols - 1)
            }
            'A' -> cursorRow = (cursorRow - (parsed.getOrElse(0) { 1 })).coerceAtLeast(0)
            'B' -> cursorRow = (cursorRow + (parsed.getOrElse(0) { 1 })).coerceAtMost(rows - 1)
            'C' -> cursorCol = (cursorCol + (parsed.getOrElse(0) { 1 })).coerceAtMost(cols - 1)
            'D' -> cursorCol = (cursorCol - (parsed.getOrElse(0) { 1 })).coerceAtLeast(0)
            'K' -> when (parsed.getOrElse(0) { 0 }) {
                0 -> for (cIdx in cursorCol until cols) screen[cursorRow][cIdx] = Cell()
                1 -> for (cIdx in 0..cursorCol.coerceAtMost(cols - 1)) screen[cursorRow][cIdx] = Cell()
                else -> for (cIdx in 0 until cols) screen[cursorRow][cIdx] = Cell()
            }
            'J' -> when (parsed.getOrElse(0) { 0 }) {
                2 -> clear()
                1 -> {
                    for (rIdx in 0..cursorRow) {
                        val upto = if (rIdx == cursorRow) cursorCol else cols
                        for (cIdx in 0 until upto.coerceAtMost(cols)) screen[rIdx][cIdx] = Cell()
                    }
                }
                else -> for (rIdx in cursorRow until rows) {
                    val from = if (rIdx == cursorRow) cursorCol else 0
                    for (cIdx in from until cols) screen[rIdx][cIdx] = Cell()
                }
            }
        }
        return j + 1
    }

    /** SGR to palette index (30-37 basic, 90-97 bright, 38;5;N 256-color). */
    private fun sgrColor(params: List<Int>): Int {
        if (params.isEmpty() || params[0] == 0 || params[0] == 39) return DEFAULT_FG
        if (params[0] == 1) return BRIGHT_FG // bold mapped to bright
        val base = params[0]
        if (base in 30..37) return base - 30
        if (base in 90..97) return base - 90 + 8
        if (base == 38 && params.size >= 3 && params[1] == 5) {
            return params[2].coerceIn(0, 255)
        }
        return currentFg
    }

    private fun scroll() {
        for (rIdx in 0 until rows - 1) {
            screen[rIdx] = screen[rIdx + 1]
        }
        screen[rows - 1] = Array(cols) { Cell() }
        cursorRow = rows - 1
    }

    fun clear() {
        for (row in screen) for (cell in row) cell.run { char = ' '; color = DEFAULT_FG }
        cursorRow = 0
        cursorCol = 0
    }

    fun colorOf(index: Int): Color = PALETTE[index and 0xFF]

    fun forEachCell(action: (row: Int, col: Int, cell: Cell) -> Unit) {
        for (rIdx in 0 until rows) {
            for (cIdx in 0 until cols) action(rIdx, cIdx, screen[rIdx][cIdx])
        }
    }

    fun cursor(): Pair<Int, Int> = cursorRow to cursorCol

    companion object {
        const val ESC = '\u001B'
        const val BEL = '\u0007'
        const val NUL = '\u0000'
        const val DEFAULT_FG = 15
        const val BRIGHT_FG = 7

        /** xterm 256-color palette: 0-15 fixed, 16-231 RGB cube, 232-255 grayscale. */
        val PALETTE: Array<Color> = run {
            val base = intArrayOf(
                0x000000, 0xCC0000, 0x00A300, 0xC7C400, 0x0000C7,
                0xC700C7, 0x00C7C7, 0xC7C7C7, 0x676767, 0xFF0000,
                0x00FF00, 0xFFFF00, 0x0000FF, 0xFF00FF, 0x00FFFF, 0xFFFFFF,
            )
            Array(256) { i ->
                val rgb = when {
                    i < 16 -> base[i]
                    i < 232 -> {
                        val c = i - 16
                        val r = (c / 36).let { if (it == 0) 0 else it * 40 + 55 }
                        val g = ((c % 36) / 6).let { if (it == 0) 0 else it * 40 + 55 }
                        val b = (c % 6).let { if (it == 0) 0 else it * 40 + 55 }
                        (r shl 16) or (g shl 8) or b
                    }
                    else -> {
                        val gray = 8 + (i - 232) * 10
                        (gray shl 16) or (gray shl 8) or gray
                    }
                }
                Color(
                    red = ((rgb shr 16) and 0xFF) / 255f,
                    green = ((rgb shr 8) and 0xFF) / 255f,
                    blue = (rgb and 0xFF) / 255f,
                )
            }
        }
    }
}

/** Precomputed monospace glyph metrics — JetBrains Mono advance is 0.6em. */
class MonospaceMetrics(val fontSize: TextUnit) {
    val charWidth: Float = fontSize.value * 0.6f
    val lineHeight: Float = fontSize.value * 1.2f
}

/**
 * Touch-interactive terminal surface: hardware-accelerated canvas wired to
 * a [TerminalEmulator], tap-to-focus for the soft keyboard.
 */
@Composable
fun TerminalSurfaceView(
    emulator: TerminalEmulator,
    modifier: Modifier = Modifier,
    fontSize: TextUnit = 13.sp,
    onTap: () -> Unit = {},
) {
    // Emulator mutations live outside Compose state - a frame ticker drives
    // invalidation at a ~30 FPS UI cadence.
    var revision by remember { mutableIntStateOf(0) }
    LaunchedEffect(emulator) {
        while (true) {
            kotlinx.coroutines.delay(33)
            revision++
        }
    }

    val metrics = remember(fontSize) { MonospaceMetrics(fontSize) }

    // JetBrains Mono — same face as the xterm.js web CloudShell (res/font).
    val context = androidx.compose.ui.platform.LocalContext.current
    val typeface = remember(context) {
        androidx.core.content.res.ResourcesCompat.getFont(
            context,
            com.mobilecloud.R.font.jetbrains_mono_400,
        ) ?: android.graphics.Typeface.MONOSPACE
    }

    Canvas(
        modifier = modifier.pointerInput(Unit) {
            detectTapGestures(onTap = { onTap() })
        }
    ) {
        revision // read so the ticker invalidates the canvas
        drawTerminal(emulator, metrics, typeface)
    }
}

private fun DrawScope.drawTerminal(
    emulator: TerminalEmulator,
    metrics: MonospaceMetrics,
    typeface: android.graphics.Typeface,
) {
    drawRect(Color(0xFF070A13)) // CIDS theme background — web-cloudshell xterm.js parity

    val paint = android.graphics.Paint().apply {
        isAntiAlias = true
        setTypeface(typeface)
        textSize = metrics.fontSize.value
    }

    emulator.forEachCell { row, col, cell ->
        if (cell.char == ' ') return@forEachCell
        val color = emulator.colorOf(cell.color)
        paint.color = android.graphics.Color.argb(
            0xFF,
            (color.red * 255).toInt(),
            (color.green * 255).toInt(),
            (color.blue * 255).toInt(),
        )
        drawContext.canvas.nativeCanvas.drawText(
            cell.char.toString(),
            col * metrics.charWidth,
            (row + 1) * metrics.lineHeight,
            paint,
        )
    }

    // Block cursor at the emulator position.
    val (crow, ccol) = emulator.cursor()
    drawRect(
        color = Color(0xFF38BDF8),
        topLeft = Offset(ccol * metrics.charWidth, crow * metrics.lineHeight),
        size = Size(metrics.charWidth, metrics.lineHeight),
        alpha = 0.55f,
    )
}
