package com.mobilecloud.terminal

import java.util.Base64

/**
 * Stateful VT100/xterm-compatible screen engine for the native CloudShell.
 *
 * This is deliberately a *terminal* rather than an ANSI-colour log:
 *
 * * primary + alternate screen buffers (`smcup`/`rmcup`, `?1049`), so `vim`,
 *   `btop`, `less`, and `tmux` restore the shell history when they exit
 * * a bounded scrollback ring that survives output bursts
 * * 24-bit colour (`38;2;r;g;b` / `48;2;r;g;b`) as well as xterm-256
 * * scroll regions, insert/delete line/char, DEC graphics, tabs, wide and
 *   combining characters, application cursor keys
 * * mouse reporting (X10, 1000/1002/1003, SGR 1006) so touch can drive tmux
 *   panes and TUIs
 * * bracketed paste, focus reporting, OSC 0/2 titles, OSC 52 clipboard
 *
 * The parser is incremental: escape sequences split across PTY reads are
 * carried across [feed] calls rather than being dropped.
 */
class TerminalEmulator(
    cols: Int = 80,
    rows: Int = 24,
    val scrollbackLimit: Int = 2_000,
) {
    @Volatile var cols: Int = cols.coerceIn(2, 500)
        private set
    @Volatile var rows: Int = rows.coerceIn(2, 500)
        private set

    /** Called once per processed chunk so the Compose layer can invalidate. */
    var onRevision: (() -> Unit)? = null
    var onTitle: ((String) -> Unit)? = null
    var onClipboardWrite: ((String) -> Unit)? = null
    var onClipboardRead: (() -> String?)? = null
    var onBell: (() -> Unit)? = null
    /** Replies the terminal must send back to the PTY (DA, DSR, OSC 10/11). */
    var onPtyReply: ((String) -> Unit)? = null

    data class Cell(
        var codePoint: Int = ' '.code,
        var fg: Int = DEFAULT_FG,
        var bg: Int = DEFAULT_BG,
        var flags: Int = 0,
        var combining: String? = null,
    ) {
        fun copyCell(): Cell = Cell(codePoint, fg, bg, flags, combining)
    }

    // Declared before the screen buffers: `blankCell()` reads these while the
    // buffers are being initialised.
    private var currentFg = DEFAULT_FG
    private var currentBg = DEFAULT_BG
    private var currentFlags = 0

    private var primary: Array<Array<Cell>> = blankScreen(rows, cols)
    private var alternate: Array<Array<Cell>> = blankScreen(rows, cols)
    private var usingAlternate = false

    /** Immutable snapshots of lines that scrolled off the primary screen. */
    private val scrollbackLines = ArrayList<Array<Cell>>(256)
    private var scrollbackStart = 0

    private val scrollbackCount: Int get() = scrollbackLines.size - scrollbackStart

    /** 0 = live bottom; N = N lines above the bottom. */
    var scrollOffset: Int = 0
        private set

    private var cursorRow = 0
    private var cursorCol = 0
    private var pendingWrap = false
    private var cursorVisible = true
    private var cursorBlink = true

    private var scrollTop = 0
    private var scrollBottom = rows - 1

    private var originMode = false
    private var autoWrap = true
    private var insertMode = false
    private var applicationCursorKeys = false
    private var applicationKeypad = false
    private var bracketedPaste = false
    private var focusReporting = false
    private var reverseVideo = false

    /** 0 = off, 9 = X10, 1000 = press/release, 1002 = drag, 1003 = any motion. */
    private var mouseTracking = 0
    private var mouseSgr = false
    private var mouseUrxvt = false

    private var tabStops = BooleanArray(cols) { it % 8 == 0 && it != 0 }

    private var g0Charset = 'B'
    private var g1Charset = 'B'
    private var activeCharset = 0

    private data class SavedCursor(
        val row: Int,
        val col: Int,
        val fg: Int,
        val bg: Int,
        val flags: Int,
        val originMode: Boolean,
        val autoWrap: Boolean,
        val charsets: Pair<Char, Char>,
        val activeCharset: Int,
    )

    private var savedPrimary: SavedCursor? = null
    private var savedAlternate: SavedCursor? = null

    private enum class ParseState { GROUND, ESCAPE, ESCAPE_CHARSET, CSI, OSC, OSC_ESC, DCS, DCS_ESC }

    private var state = ParseState.GROUND
    private val csi = StringBuilder(32)
    private val osc = StringBuilder(256)
    private val dcs = StringBuilder(256)
    private var charsetTarget = 0

    val isAlternateScreen: Boolean get() = usingAlternate
    val hasScrollback: Boolean get() = scrollbackCount > 0
    val scrollbackSize: Int get() = scrollbackCount
    val canScroll: Boolean get() = scrollbackCount > 0
    val mouseReportingEnabled: Boolean get() = mouseTracking != 0
    val bracketedPasteEnabled: Boolean get() = bracketedPaste

    fun viewportRows(): Int = rows

    // ---------------------------------------------------------------------
    // Feed
    // ---------------------------------------------------------------------

    fun feed(chunk: String) {
        var i = 0
        while (i < chunk.length) {
            val cp = chunk.codePointAt(i)
            i += Character.charCount(cp)
            consume(cp)
        }
        onRevision?.invoke()
    }

    private fun consume(cp: Int) {
        when (state) {
            ParseState.GROUND -> when {
                cp == ESC.code -> state = ParseState.ESCAPE
                cp == 0x9B -> beginCsi()
                cp == 0x9D -> beginOsc()
                cp == 0x90 -> beginDcs()
                cp < 0x20 -> control(cp)
                cp == 0x7F -> Unit
                else -> print(cp)
            }

            ParseState.ESCAPE -> escapeDispatch(cp)

            ParseState.ESCAPE_CHARSET -> {
                val designator = cp.toChar()
                if (charsetTarget == 0) g0Charset = designator else g1Charset = designator
                state = ParseState.GROUND
            }

            ParseState.CSI -> when {
                cp in 0x40..0x7E -> {
                    dispatchCsi(cp.toChar())
                    state = ParseState.GROUND
                }
                csi.length < 512 -> csi.appendCodePoint(cp)
            }

            ParseState.OSC -> when {
                cp == 0x07 -> finishOsc()
                cp == ESC.code -> state = ParseState.OSC_ESC
                osc.length < 8192 -> osc.appendCodePoint(cp)
            }

            ParseState.OSC_ESC -> {
                if (cp == '\\'.code) {
                    finishOsc()
                } else {
                    osc.append(ESC)
                    if (osc.length < 8192) osc.appendCodePoint(cp)
                    state = ParseState.OSC
                }
            }

            ParseState.DCS -> when {
                cp == ESC.code -> state = ParseState.DCS_ESC
                cp == 0x07 -> state = ParseState.GROUND
                dcs.length < 4096 -> dcs.appendCodePoint(cp)
            }

            ParseState.DCS_ESC -> {
                if (cp == '\\'.code) {
                    state = ParseState.GROUND
                    dcs.setLength(0)
                } else {
                    dcs.append(ESC)
                    state = ParseState.DCS
                }
            }
        }
    }

    private fun beginCsi() {
        csi.setLength(0)
        state = ParseState.CSI
    }

    private fun beginOsc() {
        osc.setLength(0)
        state = ParseState.OSC
    }

    private fun beginDcs() {
        dcs.setLength(0)
        state = ParseState.DCS
    }

    private fun control(cp: Int) {
        when (cp) {
            0x07 -> onBell?.invoke()
            0x08 -> {
                if (cursorCol > 0) cursorCol--
                pendingWrap = false
            }
            0x09 -> tabForward(1)
            0x0A, 0x0B, 0x0C -> lineFeed()
            0x0D -> {
                cursorCol = 0
                pendingWrap = false
            }
            0x0E -> activeCharset = 1
            0x0F -> activeCharset = 0
            else -> Unit
        }
    }

    // ---------------------------------------------------------------------
    // Printing
    // ---------------------------------------------------------------------

    private fun print(cp: Int) {
        var codePoint = cp
        if (characterSet() == '0' && codePoint in 0x5F..0x7E) {
            codePoint = DEC_GRAPHICS[codePoint - 0x5F].code
        }
        val width = wcwidth(codePoint)
        if (width == 0) {
            appendCombining(codePoint)
            return
        }
        if (pendingWrap) {
            cursorCol = 0
            lineFeed()
            pendingWrap = false
        }
        if (width == 2 && cursorCol == cols - 1) {
            cursorCol = 0
            lineFeed()
        }
        val line = screen()[cursorRow]
        if (insertMode) {
            val shift = width.coerceAtMost(cols - cursorCol)
            for (col in cols - 1 downTo cursorCol + shift) line[col] = line[col - shift]
            for (col in cursorCol until cursorCol + shift) line[col] = blankCell()
        }
        line[cursorCol] = Cell(codePoint, currentFg, currentBg, currentFlags)
        if (width == 2 && cursorCol + 1 < cols) {
            line[cursorCol + 1] = Cell(0, currentFg, currentBg, currentFlags or CONT)
        }
        cursorCol += width
        if (cursorCol >= cols) {
            cursorCol = cols - 1
            pendingWrap = true
        }
    }

    private fun appendCombining(codePoint: Int) {
        val targetCol = if (pendingWrap) (cursorCol - 1).coerceAtLeast(0) else cursorCol
        val line = screen()[cursorRow]
        val cell = line[targetCol.coerceIn(0, cols - 1)]
        val text = String(Character.toChars(codePoint))
        cell.combining = (cell.combining ?: "") + text
    }

    private fun characterSet(): Char = if (activeCharset == 1) g1Charset else g0Charset

    private fun wcwidth(codePoint: Int): Int = when {
        codePoint == 0 -> 0
        codePoint == 0x200D -> 0
        isCombining(codePoint) -> 0
        isWide(codePoint) -> 2
        else -> 1
    }

    private fun isCombining(cp: Int): Boolean = cp in 0x0300..0x036F ||
        cp in 0x0483..0x0489 || cp in 0x0591..0x05BD || cp in 0x0610..0x061A ||
        cp in 0x064B..0x065F || cp == 0x0670 || cp in 0x06D6..0x06DC ||
        cp in 0x0E31..0x0E3A || cp in 0x0E47..0x0E4E || cp in 0x1AB0..0x1AFF ||
        cp in 0x1DC0..0x1DFF || cp in 0x20D0..0x20FF || cp in 0xFE00..0xFE0F ||
        cp in 0xFE20..0xFE2F || cp in 0xE0100..0xE01EF

    private fun isWide(cp: Int): Boolean = cp in 0x1100..0x115F ||
        cp in 0x2E80..0xA4CF && cp != 0x303F || cp in 0xAC00..0xD7A3 ||
        cp in 0xF900..0xFAFF || cp in 0xFE10..0xFE19 || cp in 0xFE30..0xFE6F ||
        cp in 0xFF00..0xFF60 || cp in 0xFFE0..0xFFE6 ||
        cp in 0x1F300..0x1F64F || cp in 0x1F680..0x1F6FF ||
        cp in 0x1F900..0x1F9FF || cp in 0x1FA70..0x1FAFF ||
        cp in 0x17000..0x187FF || cp in 0x20000..0x3FFFD

    // ---------------------------------------------------------------------
    // Escape / CSI dispatch
    // ---------------------------------------------------------------------

    private fun escapeDispatch(cp: Int) {
        when (cp.toChar()) {
            '[' -> beginCsi()
            ']' -> beginOsc()
            'P' -> beginDcs()
            'X' -> Unit // SOS
            '^' -> Unit // PM
            '_' -> Unit // APC
            '7' -> saveCursor()
            '8' -> restoreCursor()
            'D' -> {
                lineFeed()
                state = ParseState.GROUND
            }
            'E' -> {
                lineFeed()
                cursorCol = 0
                state = ParseState.GROUND
            }
            'M' -> {
                reverseIndex()
                state = ParseState.GROUND
            }
            'c' -> {
                reset()
                state = ParseState.GROUND
            }
            '(' -> {
                charsetTarget = 0
                state = ParseState.ESCAPE_CHARSET
            }
            ')' -> {
                charsetTarget = 1
                state = ParseState.ESCAPE_CHARSET
            }
            '*' -> {
                charsetTarget = 2 // G2 treated as G0 in this simplified engine
                state = ParseState.ESCAPE_CHARSET
            }
            '+' -> {
                charsetTarget = 3
                state = ParseState.ESCAPE_CHARSET
            }
            '=' -> {
                applicationKeypad = true
                state = ParseState.GROUND
            }
            '>' -> {
                applicationKeypad = false
                state = ParseState.GROUND
            }
            'N', 'O' -> state = ParseState.GROUND // single shifts
            '\\' -> state = ParseState.GROUND
            '%' -> state = ParseState.GROUND // UTF-8 selection, already UTF-8
            else -> state = ParseState.GROUND
        }
        if (state == ParseState.ESCAPE) state = ParseState.GROUND
    }

    private fun dispatchCsi(final: Char) {
        val raw = csi.toString()
        var privateMarker: Char? = null
        var body = raw
        if (body.isNotEmpty() && body[0] in "?><=") {
            privateMarker = body[0]
            body = body.substring(1)
        }
        // Intermediates (space, !, ", #, $, ') are preserved after the params.
        val intermediate = body.firstOrNull { it in " !\"#$%&'()*+,-./".toSet() && it != ':' && it != ';' }
        val paramPart = if (intermediate != null) body.substringBefore(intermediate) else body
        val params = parseParams(paramPart)

        when (final) {
            'm' -> selectGraphicRendition(params)
            'H', 'f' -> cursorPosition(params, privateMarker == '?')
            'A' -> moveCursor(-1, 0, params)
            'B' -> moveCursor(1, 0, params)
            'C' -> moveCursor(0, 1, params)
            'D' -> moveCursor(0, -1, params)
            'E' -> moveCursor(1, 0, params, carriageReturn = true)
            'F' -> moveCursor(-1, 0, params, carriageReturn = true)
            'G', '`' -> cursorColumn(params)
            'd' -> cursorRow(params)
            'a' -> moveCursor(0, 1, params)
            'e' -> moveCursor(1, 0, params)
            'J' -> eraseDisplay(params.firstOrZero())
            'K' -> eraseLine(params.firstOrZero())
            'L' -> insertLines(params.firstOrOne())
            'M' -> deleteLines(params.firstOrOne())
            'P' -> deleteChars(params.firstOrOne())
            'X' -> eraseChars(params.firstOrOne())
            '@' -> insertChars(params.firstOrOne())
            'S' -> scrollUp(params.firstOrOne())
            'T' -> scrollDown(params.firstOrOne())
            'Z' -> tabBackward(params.firstOrOne())
            'g' -> tabClear(params.firstOrZero())
            'r' -> setScrollRegion(params)
            's' -> saveCursor()
            'u' -> restoreCursor()
            'h' -> setModes(params, privateMarker == '?', true)
            'l' -> setModes(params, privateMarker == '?', false)
            'n' -> deviceStatusReport(params, privateMarker == '?')
            'c' -> deviceAttributes(privateMarker)
            't' -> windowOperation(params)
            'q' -> Unit // DECSCUSR cursor style, drawn as a block
            'b' -> Unit // REP repeat: unsupported, harmless
            'i' -> Unit // media copy
            'p' -> if (intermediate == '!') softReset()
            else -> Unit
        }
        if (final == 'm' && params.isEmpty()) {
            currentFg = DEFAULT_FG
            currentBg = DEFAULT_BG
            currentFlags = 0
        }
    }

    private fun parseParams(raw: String): List<Int> {
        if (raw.isEmpty()) return emptyList()
        val out = ArrayList<Int>(8)
        for (part in raw.split(';')) {
            if (part.isEmpty()) {
                out.add(-1)
                continue
            }
            // Colon sub-parameters (38:2::R:G:B, 4:3) are flattened with -1
            // markers so SGR can walk them unambiguously.
            for (sub in part.split(':')) {
                out.add(sub.toIntOrNull()?.coerceIn(0, 999_999) ?: -1)
            }
        }
        return out
    }

    private fun List<Int>.firstOrOne(): Int = firstOrNull { it > 0 } ?: 1
    private fun List<Int>.firstOrZero(): Int = firstOrNull() ?: 0

    private fun selectGraphicRendition(params: List<Int>) {
        if (params.isEmpty()) {
            currentFg = DEFAULT_FG
            currentBg = DEFAULT_BG
            currentFlags = 0
            return
        }
        var i = 0
        while (i < params.size) {
            when (val value = params[i]) {
                0 -> {
                    currentFg = DEFAULT_FG
                    currentBg = DEFAULT_BG
                    currentFlags = 0
                }
                1 -> currentFlags = currentFlags or BOLD
                2 -> currentFlags = currentFlags or DIM
                3 -> currentFlags = currentFlags or ITALIC
                4 -> currentFlags = currentFlags or UNDERLINE
                5, 6 -> currentFlags = currentFlags or BLINK
                7 -> currentFlags = currentFlags or REVERSE
                8 -> currentFlags = currentFlags or HIDDEN
                9 -> currentFlags = currentFlags or STRIKE
                21, 22 -> currentFlags = currentFlags and (BOLD or DIM).inv()
                23 -> currentFlags = currentFlags and ITALIC.inv()
                24 -> currentFlags = currentFlags and UNDERLINE.inv()
                25 -> currentFlags = currentFlags and BLINK.inv()
                27 -> currentFlags = currentFlags and REVERSE.inv()
                28 -> currentFlags = currentFlags and HIDDEN.inv()
                29 -> currentFlags = currentFlags and STRIKE.inv()
                in 30..37 -> currentFg = palette(value - 30)
                39 -> currentFg = DEFAULT_FG
                in 40..47 -> currentBg = palette(value - 40)
                49 -> currentBg = DEFAULT_BG
                in 90..97 -> currentFg = palette(value - 90 + 8)
                in 100..107 -> currentBg = palette(value - 100 + 8)
                38, 48, 58 -> {
                    val targetBg = value == 48
                    val targetUnderline = value == 58
                    val (color, consumed) = readExtendedColor(params, i + 1)
                    if (!targetUnderline) {
                        if (targetBg) currentBg = color else currentFg = color
                    }
                    i += consumed
                }
                else -> Unit
            }
            i++
        }
    }

    /** Reads `5;n` or `2;r;g;b` (also `2::r;g;b` from colon form). */
    private fun readExtendedColor(params: List<Int>, start: Int): Pair<Int, Int> {
        if (start >= params.size) return DEFAULT_FG to 0
        return when (params[start]) {
            5 -> {
                val index = params.getOrNull(start + 1) ?: return DEFAULT_FG to 1
                palette(index.coerceIn(0, 255)) to 2
            }
            2 -> {
                var idx = start + 1
                while (idx < params.size && params[idx] < 0) idx++
                val r = params.getOrNull(idx) ?: return DEFAULT_FG to (idx - start)
                val g = params.getOrNull(idx + 1) ?: return DEFAULT_FG to (idx - start)
                val b = params.getOrNull(idx + 2) ?: return DEFAULT_FG to (idx - start)
                rgb(r, g, b) to (idx + 3 - start)
            }
            else -> DEFAULT_FG to 1
        }
    }

    private fun cursorPosition(params: List<Int>, relativeToRegion: Boolean) {
        val row = (params.getOrNull(0) ?: 1).let { if (it <= 0) 1 else it }
        val col = (params.getOrNull(1) ?: 1).let { if (it <= 0) 1 else it }
        val base = if (originMode || relativeToRegion) scrollTop else 0
        val maxRow = if (originMode || relativeToRegion) scrollBottom else rows - 1
        cursorRow = (base + row - 1).coerceIn(base, maxRow)
        cursorCol = (col - 1).coerceIn(0, cols - 1)
        pendingWrap = false
    }

    private fun cursorColumn(params: List<Int>) {
        cursorCol = ((params.getOrNull(0) ?: 1) - 1).coerceIn(0, cols - 1)
        pendingWrap = false
    }

    private fun cursorRow(params: List<Int>) {
        val base = if (originMode) scrollTop else 0
        val maxRow = if (originMode) scrollBottom else rows - 1
        cursorRow = (base + (params.getOrNull(0) ?: 1) - 1).coerceIn(base, maxRow)
        pendingWrap = false
    }

    private fun moveCursor(
        deltaRow: Int,
        deltaCol: Int,
        params: List<Int>,
        carriageReturn: Boolean = false,
    ) {
        val amount = params.firstOrNull { it > 0 } ?: 1
        val minRow = if (originMode) scrollTop else 0
        val maxRow = if (originMode) scrollBottom else rows - 1
        cursorRow = (cursorRow + deltaRow * amount).coerceIn(minRow, maxRow)
        cursorCol = (cursorCol + deltaCol * amount).coerceIn(0, cols - 1)
        if (carriageReturn) cursorCol = 0
        pendingWrap = false
    }

    private fun eraseDisplay(mode: Int) {
        when (mode) {
            0 -> {
                eraseLine(0)
                for (row in cursorRow + 1 until rows) fillRow(row)
            }
            1 -> {
                eraseLine(1)
                for (row in 0 until cursorRow) fillRow(row)
            }
            2 -> for (row in 0 until rows) fillRow(row)
            3 -> {
                scrollbackLines.clear(); scrollbackStart = 0
                scrollOffset = 0
            }
        }
    }

    private fun eraseLine(mode: Int) {
        val line = screen()[cursorRow]
        val from: Int
        val to: Int
        when (mode) {
            0 -> {
                from = cursorCol
                to = cols
            }
            1 -> {
                from = 0
                to = (cursorCol + 1).coerceAtMost(cols)
            }
            else -> {
                from = 0
                to = cols
            }
        }
        for (col in from until to) line[col] = blankCell()
        pendingWrap = false
    }

    private fun fillRow(row: Int) {
        val line = screen()[row]
        for (col in 0 until cols) line[col] = blankCell()
    }

    private fun insertLines(count: Int) {
        if (cursorRow < scrollTop || cursorRow > scrollBottom) return
        val limit = scrollBottom - cursorRow + 1
        val amount = count.coerceAtMost(limit)
        for (row in scrollBottom downTo cursorRow + amount) {
            screen()[row] = screen()[row - amount]
        }
        for (row in cursorRow until cursorRow + amount) screen()[row] = blankRow()
        cursorCol = 0
        pendingWrap = false
    }

    private fun deleteLines(count: Int) {
        if (cursorRow < scrollTop || cursorRow > scrollBottom) return
        val limit = scrollBottom - cursorRow + 1
        val amount = count.coerceAtMost(limit)
        for (row in cursorRow..scrollBottom - amount) {
            screen()[row] = screen()[row + amount]
        }
        for (row in scrollBottom - amount + 1..scrollBottom) screen()[row] = blankRow()
        cursorCol = 0
        pendingWrap = false
    }

    private fun insertChars(count: Int) {
        val line = screen()[cursorRow]
        val amount = count.coerceAtMost(cols - cursorCol)
        for (col in cols - 1 downTo cursorCol + amount) line[col] = line[col - amount]
        for (col in cursorCol until cursorCol + amount) line[col] = blankCell()
        pendingWrap = false
    }

    private fun deleteChars(count: Int) {
        val line = screen()[cursorRow]
        val amount = count.coerceAtMost(cols - cursorCol)
        for (col in cursorCol until cols - amount) line[col] = line[col + amount]
        for (col in cols - amount until cols) line[col] = blankCell()
        pendingWrap = false
    }

    private fun eraseChars(count: Int) {
        val line = screen()[cursorRow]
        for (col in cursorCol until (cursorCol + count).coerceAtMost(cols)) line[col] = blankCell()
        pendingWrap = false
    }

    private fun setScrollRegion(params: List<Int>) {
        val top = ((params.getOrNull(0) ?: 1) - 1).coerceIn(0, rows - 1)
        val bottom = ((params.getOrNull(1) ?: rows) - 1).coerceIn(0, rows - 1)
        if (top < bottom) {
            scrollTop = top
            scrollBottom = bottom
            cursorRow = if (originMode) top else 0
            cursorCol = 0
            pendingWrap = false
        }
    }

    private fun setModes(params: List<Int>, privateMode: Boolean, enable: Boolean) {
        for (mode in params) {
            if (privateMode) {
                when (mode) {
                    1 -> applicationCursorKeys = enable
                    5 -> reverseVideo = enable
                    6 -> {
                        originMode = enable
                        cursorRow = if (enable) scrollTop else 0
                        cursorCol = 0
                    }
                    7 -> autoWrap = enable
                    12 -> cursorBlink = enable
                    25 -> cursorVisible = enable
                    47, 1047 -> switchAlternate(enable, saveCursor = false)
                    1048 -> if (enable) saveCursor() else restoreCursor()
                    1049 -> switchAlternate(enable, saveCursor = true)
                    1000, 1002, 1003 -> mouseTracking = if (enable) mode else 0
                    9 -> mouseTracking = if (enable) 9 else 0
                    1005 -> mouseUrxvt = false
                    1006 -> mouseSgr = enable
                    1015 -> mouseUrxvt = enable
                    1004 -> focusReporting = enable
                    2004 -> bracketedPaste = enable
                    66 -> applicationKeypad = enable
                    else -> Unit
                }
            } else {
                when (mode) {
                    4 -> insertMode = enable
                    20 -> Unit // newline mode: LF already implies CR in this engine
                    else -> Unit
                }
            }
        }
    }

    private fun switchAlternate(enable: Boolean, saveCursor: Boolean) {
        if (enable && !usingAlternate) {
            if (saveCursor) saveCursor()
            usingAlternate = true
            scrollOffset = 0
            pendingWrap = false
        } else if (!enable && usingAlternate) {
            usingAlternate = false
            scrollOffset = 0
            pendingWrap = false
            if (saveCursor) restoreCursor()
        }
    }

    private fun deviceStatusReport(params: List<Int>, privateMode: Boolean) {
        val code = params.firstOrNull() ?: 0
        when {
            code == 5 -> onPtyReply?.invoke("\u001b[0n")
            code == 6 -> {
                val row = if (originMode) cursorRow - scrollTop + 1 else cursorRow + 1
                onPtyReply?.invoke("\u001b[$row;${cursorCol + 1}R")
            }
            code == 15 && privateMode -> onPtyReply?.invoke("\u001b[?13;2n")
            code == 25 && privateMode -> onPtyReply?.invoke("\u001b[?20;0n")
            code == 26 && privateMode -> onPtyReply?.invoke("\u001b[?27;1;0;0n")
        }
    }

    private fun deviceAttributes(marker: Char?) {
        when (marker) {
            '>' -> onPtyReply?.invoke("\u001b[>0;276;0c")
            else -> onPtyReply?.invoke("\u001b[?62;1;6;9;15;22c")
        }
    }

    private fun windowOperation(params: List<Int>) {
        when (params.firstOrNull()) {
            14 -> Unit // pixels unknown
            18 -> onPtyReply?.invoke("\u001b[8;$rows;${cols}t")
            21 -> Unit
        }
    }

    private fun softReset() {
        currentFg = DEFAULT_FG
        currentBg = DEFAULT_BG
        currentFlags = 0
        originMode = false
        autoWrap = true
        insertMode = false
        applicationCursorKeys = false
        applicationKeypad = false
        bracketedPaste = false
        mouseTracking = 0
        reverseVideo = false
        cursorVisible = true
        scrollTop = 0
        scrollBottom = rows - 1
        g0Charset = 'B'
        g1Charset = 'B'
        activeCharset = 0
    }

    private fun reset() {
        softReset()
        primary = blankScreen(rows, cols)
        alternate = blankScreen(rows, cols)
        usingAlternate = false
        scrollbackLines.clear(); scrollbackStart = 0
        scrollOffset = 0
        cursorRow = 0
        cursorCol = 0
        pendingWrap = false
        tabStops = BooleanArray(cols) { it % 8 == 0 && it != 0 }
        savedPrimary = null
        savedAlternate = null
    }

    // ---------------------------------------------------------------------
    // Scrolling / buffers
    // ---------------------------------------------------------------------

    private fun lineFeed() {
        pendingWrap = false
        if (cursorRow == scrollBottom) {
            scrollUp(1)
        } else if (cursorRow < rows - 1) {
            cursorRow++
        }
    }

    private fun reverseIndex() {
        if (cursorRow == scrollTop) {
            scrollDown(1)
        } else if (cursorRow > 0) {
            cursorRow--
        }
    }

    private fun scrollUp(count: Int) {
        val amount = count.coerceIn(1, scrollBottom - scrollTop + 1)
        val buffer = screen()
        repeat(amount) {
            if (buffer === primary && scrollTop == 0 && scrollBottom == rows - 1) {
                pushScrollback(buffer[0])
                for (row in 0 until rows - 1) buffer[row] = buffer[row + 1]
                buffer[rows - 1] = blankRow()
            } else {
                for (row in scrollTop until scrollBottom) buffer[row] = buffer[row + 1]
                buffer[scrollBottom] = blankRow()
            }
        }
    }

    private fun scrollDown(count: Int) {
        val amount = count.coerceIn(1, scrollBottom - scrollTop + 1)
        val buffer = screen()
        repeat(amount) {
            for (row in scrollBottom downTo scrollTop + 1) buffer[row] = buffer[row - 1]
            buffer[scrollTop] = blankRow()
        }
    }

    private fun pushScrollback(line: Array<Cell>) {
        scrollbackLines.add(line)
        while (scrollbackCount > scrollbackLimit) { scrollbackStart += 1; if (scrollbackStart > 1024) { scrollbackLines.subList(0, scrollbackStart).clear(); scrollbackStart = 0 } }
    }

    private fun screen(): Array<Array<Cell>> = if (usingAlternate) alternate else primary

    private fun blankScreen(rowCount: Int, colCount: Int): Array<Array<Cell>> =
        Array(rowCount) { blankRow(colCount) }

    private fun blankRow(colCount: Int = cols): Array<Cell> =
        Array(colCount) { blankCell() }

    private fun blankCell(): Cell = Cell(' '.code, DEFAULT_FG, currentBg, 0)

    private fun saveCursor() {
        val saved = SavedCursor(
            row = cursorRow,
            col = cursorCol,
            fg = currentFg,
            bg = currentBg,
            flags = currentFlags,
            originMode = originMode,
            autoWrap = autoWrap,
            charsets = g0Charset to g1Charset,
            activeCharset = activeCharset,
        )
        if (usingAlternate) savedAlternate = saved else savedPrimary = saved
    }

    private fun restoreCursor() {
        val saved = (if (usingAlternate) savedAlternate else savedPrimary) ?: return
        cursorRow = saved.row.coerceIn(0, rows - 1)
        cursorCol = saved.col.coerceIn(0, cols - 1)
        currentFg = saved.fg
        currentBg = saved.bg
        currentFlags = saved.flags
        originMode = saved.originMode
        autoWrap = saved.autoWrap
        g0Charset = saved.charsets.first
        g1Charset = saved.charsets.second
        activeCharset = saved.activeCharset
        pendingWrap = false
    }

    // ---------------------------------------------------------------------
    // Tabs
    // ---------------------------------------------------------------------

    private fun tabForward(count: Int) {
        repeat(count) {
            var next = (cursorCol + 1).coerceAtMost(cols - 1)
            while (next < cols - 1 && !tabStops[next]) next++
            cursorCol = next
        }
        pendingWrap = false
    }

    private fun tabBackward(count: Int) {
        repeat(count) {
            var previous = (cursorCol - 1).coerceAtLeast(0)
            while (previous > 0 && !tabStops[previous]) previous--
            cursorCol = previous
        }
        pendingWrap = false
    }

    private fun tabClear(mode: Int) {
        if (mode == 0) {
            tabStops[cursorCol] = false
        } else if (mode == 3) {
            tabStops = BooleanArray(cols)
        }
    }

    // ---------------------------------------------------------------------
    // Ctrl-sequences sent by the host (OSC replies, clipboard)
    // ---------------------------------------------------------------------

    private fun finishOsc() {
        val payload = osc.toString()
        osc.setLength(0)
        state = ParseState.GROUND
        val command = payload.substringBefore(';')
        val rest = payload.substringAfter(';', "")
        when (command) {
            "0", "1", "2" -> onTitle?.invoke(rest)
            "52" -> handleClipboard(rest)
            "10" -> onPtyReply?.invoke("\u001b]10;rgb:e2e2/e8e8/f0f0\u001b\\")
            "11" -> onPtyReply?.invoke("\u001b]11;rgb:0707/0a0a/1313\u001b\\")
            "4", "104", "110", "111", "112", "133", "1337", "8", "7" -> Unit
            else -> Unit
        }
    }

    private fun handleClipboard(rest: String) {
        val selector = rest.substringBefore(';')
        val data = rest.substringAfter(';', "")
        if (data == "?") {
            val content = onClipboardRead?.invoke() ?: return
            val encoded = Base64.getEncoder().encodeToString(content.toByteArray(Charsets.UTF_8))
            onPtyReply?.invoke("\u001b]52;$selector;$encoded\u001b\\")
            return
        }
        if (data.isEmpty()) return
        val decoded = runCatching {
            String(Base64.getDecoder().decode(data), Charsets.UTF_8)
        }.getOrNull() ?: return
        if (decoded.isNotEmpty()) onClipboardWrite?.invoke(decoded)
    }

    // ---------------------------------------------------------------------
    // Public helpers for the Compose layer
    // ---------------------------------------------------------------------

    /** Cell at a viewport coordinate (0 = top visible line). */
    fun visibleCell(viewRow: Int, col: Int): Cell {
        if (viewRow < 0 || viewRow >= rows || col < 0 || col >= cols) return EMPTY_CELL
        val absolute = scrollbackAbsolute(viewRow)
        return if (absolute < scrollbackCount) {
            scrollbackLines[scrollbackStart + absolute][col]
        } else {
            screen()[absolute - scrollbackCount][col]
        }
    }

    private fun scrollbackAbsolute(viewRow: Int): Int =
        (scrollbackCount - scrollOffset + viewRow).coerceAtLeast(0)

    fun cursorViewPosition(): Pair<Int, Int>? {
        if (scrollOffset != 0) return null
        return cursorRow to cursorCol
    }

    fun cursorRowVisible(): Int = cursorRow
    fun cursorColVisible(): Int = cursorCol
    fun cursorIsVisible(): Boolean = cursorVisible
    fun reverseVideoEnabled(): Boolean = reverseVideo

    fun scrollViewport(lines: Int) {
        scrollOffset = (scrollOffset + lines).coerceIn(0, scrollbackCount)
        onRevision?.invoke()
    }

    fun scrollToBottom() {
        if (scrollOffset != 0) {
            scrollOffset = 0
            onRevision?.invoke()
        }
    }

    fun pageUp() = scrollViewport(rows - 2)
    fun pageDown() = scrollViewport(-(rows - 2))

    fun resize(newCols: Int, newRows: Int) {
        val targetCols = newCols.coerceIn(2, 500)
        val targetRows = newRows.coerceIn(2, 500)
        if (targetCols == cols && targetRows == rows) return

        // Lines that fall off the top of the primary screen become scrollback.
        // When the alternate screen is active the primary buffer is hidden and
        // must not be harvested — that would duplicate history on every rotation.
        val removedTop = (rows - targetRows).coerceAtLeast(0)
        if (removedTop > 0 && !usingAlternate) {
            repeat(removedTop) { pushScrollback(primary[it]) }
        }
        primary = resizeBuffer(primary, targetCols, targetRows, removedTop)
        alternate = resizeBuffer(alternate, targetCols, targetRows, removedTop)

        cols = targetCols
        rows = targetRows
        if (scrollOffset > scrollbackCount) scrollOffset = scrollbackCount
        cursorRow = cursorRow.coerceIn(0, rows - 1)
        cursorCol = cursorCol.coerceIn(0, cols - 1)
        scrollTop = scrollTop.coerceIn(0, rows - 1)
        scrollBottom = if (scrollBottom >= rows) rows - 1 else scrollBottom.coerceAtLeast(scrollTop)
        val oldTabs = tabStops
        tabStops = BooleanArray(cols) { index ->
            index < oldTabs.size && oldTabs[index] || index >= oldTabs.size && index % 8 == 0
        }
        pendingWrap = false
        onRevision?.invoke()
    }

    /**
     * Copy a buffer into a new geometry. Top lines are dropped when shrinking;
     * when growing the existing content is anchored to the bottom, matching how
     * a real terminal reflows around a cursor sitting on the last row.
     */
    private fun resizeBuffer(
        source: Array<Array<Cell>>,
        targetCols: Int,
        targetRows: Int,
        removedTop: Int,
    ): Array<Array<Cell>> {
        val result = Array(targetRows) { Array(targetCols) { Cell() } }
        val dropped = removedTop.coerceIn(0, source.size)
        val retained = source.size - dropped
        val verticalOffset = (targetRows - retained).coerceAtLeast(0)
        for (row in 0 until retained) {
            val destRow = verticalOffset + row
            if (destRow >= targetRows) break
            val sourceRow = source[dropped + row]
            for (col in 0 until targetCols) {
                if (col < sourceRow.size) result[destRow][col] = sourceRow[col]
            }
        }
        return result
    }

    fun resetScrollback() {
        scrollbackLines.clear(); scrollbackStart = 0
        scrollOffset = 0
        onRevision?.invoke()
    }

    // ---------------------------------------------------------------------
    // Key / mouse encoders
    // ---------------------------------------------------------------------

    /** Encode any named key with the terminal's current cursor-key mode. */
    fun encodeKey(key: TerminalKey, modifiers: KeyModifiers = KeyModifiers()): String =
        TerminalKeyEncoder.encode(key, modifiers, applicationCursorKeys)

    fun cursorKey(
        up: Boolean = false,
        down: Boolean = false,
        left: Boolean = false,
        right: Boolean = false,
        modifiers: KeyModifiers = KeyModifiers(),
    ): String {
        val key = when {
            up -> TerminalKey.UP
            down -> TerminalKey.DOWN
            right -> TerminalKey.RIGHT
            else -> TerminalKey.LEFT
        }
        return encodeKey(key, modifiers)
    }

    fun homeKey(modifiers: KeyModifiers = KeyModifiers()): String =
        encodeKey(TerminalKey.HOME, modifiers)

    fun endKey(modifiers: KeyModifiers = KeyModifiers()): String =
        encodeKey(TerminalKey.END, modifiers)

    fun functionKey(number: Int, modifiers: KeyModifiers = KeyModifiers()): String =
        encodeKey(
            when (number) {
                1 -> TerminalKey.F1
                2 -> TerminalKey.F2
                3 -> TerminalKey.F3
                4 -> TerminalKey.F4
                5 -> TerminalKey.F5
                6 -> TerminalKey.F6
                7 -> TerminalKey.F7
                8 -> TerminalKey.F8
                9 -> TerminalKey.F9
                10 -> TerminalKey.F10
                11 -> TerminalKey.F11
                else -> TerminalKey.F12
            },
            modifiers,
        )

    fun paste(text: String): String =
        if (bracketedPaste) "\u001b[200~$text\u001b[201~" else text

    fun focusGained(): String = if (focusReporting) "\u001b[I" else ""
    fun focusLost(): String = if (focusReporting) "\u001b[O" else ""

    /**
     * Encode a touch/mouse event for the running program. Returns `null` when
     * mouse reporting is off (callers should scroll the local viewport instead).
     */
    fun mouseEvent(
        action: MouseAction,
        button: Int,
        col: Int,
        row: Int,
        shift: Boolean = false,
        alt: Boolean = false,
        ctrl: Boolean = false,
    ): String? {
        if (mouseTracking == 0) return null
        val clampedCol = col.coerceIn(0, cols - 1)
        val clampedRow = row.coerceIn(0, rows - 1)
        if (action == MouseAction.MOVE && mouseTracking == 1000) return null
        if (action == MouseAction.MOVE && mouseTracking == 1002 && button < 0) return null

        var buttonCode = when (action) {
            MouseAction.WHEEL_UP -> 64
            MouseAction.WHEEL_DOWN -> 65
            MouseAction.WHEEL_LEFT -> 66
            MouseAction.WHEEL_RIGHT -> 67
            else -> when (button) {
                1 -> 1
                2 -> 2
                else -> 0
            }
        }
        if (action == MouseAction.MOVE) buttonCode = 32 + 3
        if (action == MouseAction.RELEASE && !mouseSgr) buttonCode = 3

        var modifiers = 0
        if (shift) modifiers = modifiers or 4
        if (alt) modifiers = modifiers or 8
        if (ctrl) modifiers = modifiers or 16

        if (mouseSgr) {
            val releaseSuffix = if (action == MouseAction.RELEASE) 'm' else 'M'
            val code = when (action) {
                MouseAction.RELEASE -> buttonCode
                else -> buttonCode
            } + modifiers
            return "\u001b[<$code;${clampedCol + 1};${clampedRow + 1}$releaseSuffix"
        }

        val encoded = buttonCode + modifiers + 32
        if (mouseUrxvt) {
            return "\u001b[$encoded;${clampedCol + 1};${clampedRow + 1}M"
        }
        if (encoded > 223 || clampedCol + 1 > 223 || clampedRow + 1 > 223) {
            // X10 cannot address large screens; fall back to SGR wire format.
            return "\u001b[<$encoded;${clampedCol + 1};${clampedRow + 1}M"
        }
        return "\u001b[M" +
            encoded.toChar() +
            (clampedCol + 1 + 32).toChar() +
            (clampedRow + 1 + 32).toChar()
    }

    enum class MouseAction { PRESS, RELEASE, MOVE, WHEEL_UP, WHEEL_DOWN, WHEEL_LEFT, WHEEL_RIGHT }

    companion object {
        const val DEFAULT_FG = 0xE2E8F0
        const val DEFAULT_BG = 0x070A13

        const val BOLD = 1
        const val DIM = 2
        const val ITALIC = 4
        const val UNDERLINE = 8
        const val BLINK = 16
        const val REVERSE = 32
        const val HIDDEN = 64
        const val STRIKE = 128
        /** Wide-character continuation cell. */
        const val CONT = 256

        private const val ESC = '\u001b'
        private val EMPTY_CELL = Cell()

        private val BASE_PALETTE = intArrayOf(
            0x000000, 0xCC0000, 0x00A300, 0xC7C400, 0x0000C7, 0xC700C7, 0x00C7C7, 0xC7C7C7,
            0x676767, 0xFF0000, 0x00FF00, 0xFFFF00, 0x0000FF, 0xFF00FF, 0x00FFFF, 0xFFFFFF,
        )

        private val DEC_GRAPHICS = charArrayOf(
            ' ', '◆', '▒', '␉', '␌', '␍', '␊', '°', '±', '␤', '␋', '┘', '┐', '┌', '└', '┼',
            '⎺', '⎻', '─', '⎼', '⎽', '├', '┤', '┴', '┬', '│', '≤', '≥', 'π', '≠', '£', '·',
        )

        fun palette(index: Int): Int {
            val i = index and 0xFF
            return when {
                i < 16 -> BASE_PALETTE[i]
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
        }

        fun rgb(r: Int, g: Int, b: Int): Int =
            ((r and 0xFF) shl 16) or ((g and 0xFF) shl 8) or (b and 0xFF)
    }
}
