package com.mobilecloud.terminal

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlin.math.roundToInt

/** Precomputed monospace glyph metrics — JetBrains Mono advance is ~0.6em. */
class MonospaceMetrics(fontSizePx: Float) {
    val charWidth: Float = fontSizePx * 0.6f
    val lineHeight: Float = fontSizePx * 1.28f
}

/**
 * Touch-interactive terminal surface: hardware-accelerated canvas wired to a
 * [TerminalEmulator], with real IME input, hardware key mapping, mouse
 * reporting, and scrollback drag.
 *
 * Redraws are **reactive**: [TerminalEmulator.onRevision] fires only when the
 * engine receives bytes or the viewport moves. There is no frame ticker, so an
 * idle shell costs zero GPU work (the previous 30 FPS `delay(33)` loop redrew
 * 1,920 cells forever).
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun TerminalSurfaceView(
    emulator: TerminalEmulator,
    modifier: Modifier = Modifier,
    fontSize: TextUnit = 13.sp,
    focusRequester: FocusRequester? = null,
    onResize: (cols: Int, rows: Int) -> Unit = { _, _ -> },
    onInput: (String) -> Unit = {},
    onClipboard: (String) -> Unit = {},
    onClipboardRead: () -> String? = { null },
    onScrollState: (scrolledBack: Boolean) -> Unit = {},
    onTap: () -> Unit = {},
) {
    var revision by remember(emulator) { mutableIntStateOf(0) }
    val currentInput by rememberUpdatedState(onInput)
    val currentClipboard by rememberUpdatedState(onClipboard)
    val currentClipboardRead by rememberUpdatedState(onClipboardRead)
    val currentScrollState by rememberUpdatedState(onScrollState)
    DisposableEffect(emulator) {
        emulator.onRevision = {
            revision += 1
            currentScrollState(emulator.scrollOffset != 0)
        }
        // DA/DSR/OSC-10/11 replies and clipboard reads are terminal traffic too.
        emulator.onPtyReply = { currentInput(it) }
        emulator.onClipboardWrite = { currentClipboard(it) }
        emulator.onClipboardRead = { currentClipboardRead() }
        onDispose {
            emulator.onRevision = null
            emulator.onPtyReply = null
            emulator.onClipboardWrite = null
            emulator.onClipboardRead = null
        }
    }

    val density = LocalDensity.current
    val metrics = remember(fontSize, density) {
        MonospaceMetrics(with(density) { fontSize.toPx() })
    }
    val context = LocalContext.current
    val typeface = remember(context) {
        androidx.core.content.res.ResourcesCompat.getFont(
            context,
            com.mobilecloud.R.font.jetbrains_mono_400,
        ) ?: android.graphics.Typeface.MONOSPACE
    }

    val internalFocusRequester = remember { FocusRequester() }
    val effectiveFocusRequester = focusRequester ?: internalFocusRequester
    val keyboard = LocalSoftwareKeyboardController.current
    var grid by remember { mutableStateOf(0 to 0) }

    fun send(raw: String) {
        if (raw.isNotEmpty()) {
            emulator.scrollToBottom()
            onInput(raw)
        }
    }

    fun cellAt(offset: Offset): Pair<Int, Int> = (
        (offset.x / metrics.charWidth).toInt().coerceIn(0, emulator.cols - 1) to
            (offset.y / metrics.lineHeight).toInt().coerceIn(0, emulator.rows - 1)
        )

    fun mouse(
        action: TerminalEmulator.MouseAction,
        button: Int,
        offset: Offset,
    ): Boolean {
        val (col, row) = cellAt(offset)
        val sequence = emulator.mouseEvent(action, button, col, row) ?: return false
        send(sequence)
        return true
    }

    fun focusAndShowKeyboard() {
        onTap()
        runCatching { effectiveFocusRequester.requestFocus() }
        keyboard?.show()
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color(0xFF070A13))
            .onSizeChanged { size ->
                val cols = (size.width / metrics.charWidth).toInt().coerceAtLeast(2)
                val rows = (size.height / metrics.lineHeight).toInt().coerceAtLeast(2)
                if (grid != cols to rows) grid = cols to rows
            }
            .onPreviewKeyEvent { event -> handleHardwareKey(event, emulator, ::send) },
    ) {
        LaunchedEffect(grid, emulator) {
            val (cols, rows) = grid
            if (cols >= 2 && rows >= 2 && (cols != emulator.cols || rows != emulator.rows)) {
                emulator.resize(cols, rows)
                onResize(cols, rows)
            }
        }

        Canvas(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(emulator, metrics) {
                    detectTapGestures(
                        onTap = { offset ->
                            // A tap is a left click in a mouse-aware TUI, and
                            // keyboard focus everywhere else.
                            if (!mouse(TerminalEmulator.MouseAction.PRESS, 0, offset)) {
                                focusAndShowKeyboard()
                            } else {
                                mouse(TerminalEmulator.MouseAction.RELEASE, 0, offset)
                                runCatching { effectiveFocusRequester.requestFocus() }
                            }
                        },
                    )
                }
                .pointerInput(emulator, metrics) {
                    var accumulatedY = 0f
                    var dragging = false
                    detectDragGestures(
                        onDragStart = { offset ->
                            dragging = emulator.mouseReportingEnabled &&
                                mouse(TerminalEmulator.MouseAction.PRESS, 0, offset)
                        },
                        onDragEnd = { dragging = false },
                        onDragCancel = { dragging = false },
                    ) { change, dragAmount ->
                        if (dragging) {
                            mouse(TerminalEmulator.MouseAction.MOVE, 0, change.position)
                        } else {
                            accumulatedY += dragAmount.y
                            val step = metrics.lineHeight
                            while (abs(accumulatedY) >= step) {
                                val lines = if (accumulatedY > 0) 1 else -1
                                emulator.scrollViewport(lines)
                                accumulatedY -= lines * step
                            }
                        }
                    }
                }
                .pointerInput(emulator, metrics) {
                    // Mouse wheel / trackpad scroll. `Modifier.onPointerEvent` is
                    // not public API in this Compose version, so the event is
                    // observed directly in the pointer input scope.
                    awaitPointerEventScope {
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Final)
                            if (event.type != PointerEventType.Scroll) continue
                            val change = event.changes.firstOrNull() ?: continue
                            val scroll = change.scrollDelta.y
                            if (scroll == 0f) continue
                            if (!mouse(
                                    if (scroll > 0) TerminalEmulator.MouseAction.WHEEL_DOWN
                                    else TerminalEmulator.MouseAction.WHEEL_UP,
                                    0,
                                    change.position,
                                )
                            ) {
                                emulator.scrollViewport(if (scroll > 0) -1 else 1)
                            }
                        }
                    }
                },
        ) {
            revision // read to subscribe the canvas to engine mutations
            drawTerminal(emulator, metrics, typeface)
        }

        // Invisible IME capture. A zero-width sentinel keeps Backspace
        // observable even when the field is otherwise empty.
        TerminalInputField(
            emulator = emulator,
            onInput = ::send,
            focusRequester = effectiveFocusRequester,
            modifier = Modifier
                .size(1.dp)
                .alpha(0.01f),
        )
    }
}

private const val SENTINEL = "\u200B"

@Composable
private fun TerminalInputField(
    emulator: TerminalEmulator,
    onInput: (String) -> Unit,
    focusRequester: FocusRequester,
    modifier: Modifier = Modifier,
) {
    var value by remember {
        mutableStateOf(TextFieldValue(SENTINEL, TextRange(SENTINEL.length)))
    }
    BasicTextField(
        value = value,
        onValueChange = { next ->
            val before = value.text
            val after = next.text
            var common = 0
            while (common < before.length && common < after.length && before[common] == after[common]) {
                common++
            }
            val removed = before.length - common
            val added = after.substring(common)
            if (removed > 0) repeat(removed) { onInput("\u007F") }
            if (added.isNotEmpty()) onInput(added.replace('\n', '\r'))
            emulator.scrollToBottom()
            value = TextFieldValue(SENTINEL, TextRange(SENTINEL.length))
        },
        textStyle = TextStyle(fontSize = 1.sp, color = Color.Transparent),
        cursorBrush = SolidColor(Color.Transparent),
        keyboardOptions = KeyboardOptions(
            autoCorrectEnabled = false,
            capitalization = KeyboardCapitalization.None,
            keyboardType = KeyboardType.Ascii,
            imeAction = ImeAction.None,
        ),
        modifier = modifier.focusRequester(focusRequester),
    )
}

private fun handleHardwareKey(
    event: KeyEvent,
    emulator: TerminalEmulator,
    send: (String) -> Unit,
): Boolean {
    if (event.type != KeyEventType.KeyDown) return false
    val modifiers = KeyModifiers(
        ctrl = event.isCtrlPressed,
        alt = event.isAltPressed,
        shift = event.isShiftPressed,
    )

    fun emit(sequence: String): Boolean {
        send(sequence)
        return true
    }

    fun named(key: TerminalKey): Boolean = emit(emulator.encodeKey(key, modifiers))

    return when (event.key) {
        Key.Enter, Key.NumPadEnter -> named(TerminalKey.ENTER)
        Key.Backspace -> named(TerminalKey.BACKSPACE)
        Key.Escape -> named(TerminalKey.ESC)
        Key.Tab -> named(TerminalKey.TAB)
        Key.Delete -> named(TerminalKey.DELETE)
        Key.Insert -> named(TerminalKey.INSERT)
        Key.MoveHome -> named(TerminalKey.HOME)
        Key.MoveEnd -> named(TerminalKey.END)
        Key.PageUp -> named(TerminalKey.PAGE_UP)
        Key.PageDown -> named(TerminalKey.PAGE_DOWN)
        Key.DirectionUp -> named(TerminalKey.UP)
        Key.DirectionDown -> named(TerminalKey.DOWN)
        Key.DirectionLeft -> named(TerminalKey.LEFT)
        Key.DirectionRight -> named(TerminalKey.RIGHT)
        Key.F1 -> named(TerminalKey.F1)
        Key.F2 -> named(TerminalKey.F2)
        Key.F3 -> named(TerminalKey.F3)
        Key.F4 -> named(TerminalKey.F4)
        Key.F5 -> named(TerminalKey.F5)
        Key.F6 -> named(TerminalKey.F6)
        Key.F7 -> named(TerminalKey.F7)
        Key.F8 -> named(TerminalKey.F8)
        Key.F9 -> named(TerminalKey.F9)
        Key.F10 -> named(TerminalKey.F10)
        Key.F11 -> named(TerminalKey.F11)
        Key.F12 -> named(TerminalKey.F12)
        else -> {
            val codePoint = event.utf16CodePoint
            when {
                // Some Android IMEs already deliver Ctrl+letter as its C0 byte.
                codePoint in 1..26 -> emit(codePoint.toChar().toString())
                codePoint == 0 -> emit("\u0000")
                codePoint >= 0x20 -> emit(
                    modifiers.applyToText(String(Character.toChars(codePoint))),
                )
                else -> false
            }
        }
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
        textSize = metrics.charWidth / 0.6f
    }
    val boldPaint = android.graphics.Paint(paint)
    val overallReverse = emulator.reverseVideoEnabled()

    for (row in 0 until emulator.rows) {
        for (col in 0 until emulator.cols) {
            val cell = emulator.visibleCell(row, col)
            if (cell.flags and TerminalEmulator.CONT != 0) continue
            if (cell.codePoint == ' '.code && cell.combining == null &&
                cell.bg == TerminalEmulator.DEFAULT_BG
            ) {
                continue
            }

            var fg = cell.fg
            var bg = cell.bg
            if (overallReverse || cell.flags and TerminalEmulator.REVERSE != 0) {
                val swap = fg; fg = bg; bg = swap
                if (bg == 0x070A13) bg = 0xE2E8F0.takeIf { fg == 0x070A13 } ?: bg
            }
            if (cell.flags and TerminalEmulator.HIDDEN != 0) fg = bg

            if (bg != TerminalEmulator.DEFAULT_BG) {
                drawRect(
                    color = Color(0xFF000000.toInt() or (bg and 0xFFFFFF)),
                    topLeft = Offset(col * metrics.charWidth, row * metrics.lineHeight),
                    size = Size(metrics.charWidth, metrics.lineHeight),
                )
            }
            if (cell.codePoint == ' '.code) continue

            val isWide = emulator.visibleCell(row, col + 1)
                .let { it.flags and TerminalEmulator.CONT != 0 }
            val glyph = buildString {
                appendCodePoint(cell.codePoint)
                cell.combining?.let { append(it) }
            }
            val target = if (cell.flags and (TerminalEmulator.BOLD or TerminalEmulator.BLINK) != 0) {
                boldPaint
            } else {
                paint
            }
            target.color = android.graphics.Color.argb(
                0xFF,
                ((fg shr 16) and 0xFF),
                ((fg shr 8) and 0xFF),
                (fg and 0xFF),
            )
            if (cell.flags and TerminalEmulator.DIM != 0) {
                target.alpha = 0xC0
            } else {
                target.alpha = 0xFF
            }
            target.isFakeBoldText = cell.flags and TerminalEmulator.BOLD != 0
            target.textSkewX = if (cell.flags and TerminalEmulator.ITALIC != 0) -0.22f else 0f
            target.isUnderlineText = cell.flags and TerminalEmulator.UNDERLINE != 0
            target.isStrikeThruText = cell.flags and TerminalEmulator.STRIKE != 0
            target.textScaleX = if (isWide) {
                val natural = target.measureText(glyph)
                if (natural > 0f) (metrics.charWidth * 2f) / natural else 1f
            } else {
                1f
            }

            drawContext.canvas.nativeCanvas.drawText(
                glyph,
                col * metrics.charWidth,
                row * metrics.lineHeight + metrics.lineHeight * 0.8f,
                target,
            )
        }
    }

    // Block cursor; omitted while the user is reading scrollback.
    val cursor = emulator.cursorViewPosition()
    if (cursor != null && emulator.cursorIsVisible()) {
        drawRect(
            color = Color(0xFF38BDF8),
            topLeft = Offset(cursor.second * metrics.charWidth, cursor.first * metrics.lineHeight),
            size = Size(metrics.charWidth, metrics.lineHeight),
            alpha = 0.5f,
        )
    }
}
