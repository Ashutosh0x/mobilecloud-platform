package com.mobilecloud.terminal

/**
 * Named keys the accessory bar, a hardware keyboard, or an on-screen shortcut
 * can emit. Encoding lives in [TerminalKeyEncoder] so every input path produces
 * the same byte sequence for the same key.
 */
enum class TerminalKey {
    ESC,
    TAB,
    ENTER,
    BACKSPACE,
    DELETE,
    INSERT,
    HOME,
    END,
    PAGE_UP,
    PAGE_DOWN,
    UP,
    DOWN,
    LEFT,
    RIGHT,
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
    ;

    /** Short label for the touch key bar. */
    val label: String
        get() = when (this) {
            ESC -> "ESC"
            TAB -> "TAB"
            ENTER -> "⏎"
            BACKSPACE -> "⌫"
            DELETE -> "DEL"
            INSERT -> "INS"
            HOME -> "HOME"
            END -> "END"
            PAGE_UP -> "PGUP"
            PAGE_DOWN -> "PGDN"
            UP -> "▲"
            DOWN -> "▼"
            LEFT -> "◀"
            RIGHT -> "▶"
            F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12 -> name
        }
}

/**
 * Sticky modifier state for one key press. `ctrl` maps printable characters to
 * their C0 control byte, `alt` prefixes ESC, and `shift` upper-cases letters —
 * the same conventions Termux uses, so muscle memory carries over.
 */
data class KeyModifiers(
    val ctrl: Boolean = false,
    val alt: Boolean = false,
    val shift: Boolean = false,
) {
    val any: Boolean get() = ctrl || alt || shift

    /** xterm parameter for modified keys: 1 + shift + 2·alt + 4·ctrl. */
    val xtermParameter: Int
        get() = 1 + (if (shift) 1 else 0) + (if (alt) 2 else 0) + (if (ctrl) 4 else 0)

    /** Apply the modifiers to a printable string (typically one character). */
    fun applyToText(text: String): String {
        if (text.isEmpty() || !any) return text
        val first = text.first()
        var result = when {
            ctrl -> controlByte(first).toString() + text.substring(1)
            shift -> first.uppercaseChar().toString() + text.substring(1)
            else -> text
        }
        if (alt) result = "\u001b$result"
        return result
    }

    private fun controlByte(ch: Char): Char = when (ch) {
        in 'a'..'z' -> (ch.code and 0x1F).toChar()
        in 'A'..'Z' -> (ch.code and 0x1F).toChar()
        ' ', '@', '2' -> '\u0000'
        '[' -> '\u001b'
        '\\' -> '\u001c'
        ']' -> '\u001d'
        '^', '6' -> '\u001e'
        '_', '/' -> '\u001f'
        '?' -> '\u007f'
        else -> ch
    }
}

/** Shared byte encoder for every non-printable key. */
object TerminalKeyEncoder {
    fun encode(
        key: TerminalKey,
        modifiers: KeyModifiers = KeyModifiers(),
        applicationCursorKeys: Boolean = false,
    ): String {
        val m = modifiers.xtermParameter
        val modified = modifiers.any
        return when (key) {
            TerminalKey.ESC -> "\u001b"
            TerminalKey.TAB -> when {
                modifiers.alt -> "\u001b\t"
                modifiers.shift -> "\u001b[Z"
                else -> "\t"
            }
            TerminalKey.ENTER -> (if (modifiers.alt) "\u001b" else "") + "\r"
            TerminalKey.BACKSPACE ->
                (if (modifiers.alt) "\u001b" else "") +
                    if (modifiers.ctrl) "\b" else "\u007f"
            TerminalKey.DELETE -> sequence("3", m, modified)
            TerminalKey.INSERT -> sequence("2", m, modified)
            TerminalKey.PAGE_UP -> sequence("5", m, modified)
            TerminalKey.PAGE_DOWN -> sequence("6", m, modified)
            TerminalKey.HOME -> when {
                modified -> "\u001b[1;${m}H"
                applicationCursorKeys -> "\u001bOH"
                else -> "\u001b[H"
            }
            TerminalKey.END -> when {
                modified -> "\u001b[1;${m}F"
                applicationCursorKeys -> "\u001bOF"
                else -> "\u001b[F"
            }
            TerminalKey.UP -> cursor('A', applicationCursorKeys, modifiers)
            TerminalKey.DOWN -> cursor('B', applicationCursorKeys, modifiers)
            TerminalKey.RIGHT -> cursor('C', applicationCursorKeys, modifiers)
            TerminalKey.LEFT -> cursor('D', applicationCursorKeys, modifiers)
            TerminalKey.F1 -> function(1, m)
            TerminalKey.F2 -> function(2, m)
            TerminalKey.F3 -> function(3, m)
            TerminalKey.F4 -> function(4, m)
            TerminalKey.F5 -> function(5, m)
            TerminalKey.F6 -> function(6, m)
            TerminalKey.F7 -> function(7, m)
            TerminalKey.F8 -> function(8, m)
            TerminalKey.F9 -> function(9, m)
            TerminalKey.F10 -> function(10, m)
            TerminalKey.F11 -> function(11, m)
            TerminalKey.F12 -> function(12, m)
        }
    }

    private fun cursor(final: Char, application: Boolean, modifiers: KeyModifiers): String {
        if (modifiers.any) return "\u001b[1;${modifiers.xtermParameter}$final"
        return if (application) "\u001bO$final" else "\u001b[$final"
    }

    /** CSI number ~ keys: `ESC [ 3 ~` or `ESC [ 3 ; m ~` when modified. */
    private fun sequence(number: String, parameter: Int, modified: Boolean): String =
        if (modified) "\u001b[$number;$parameter~" else "\u001b[$number~"

    private fun function(number: Int, parameter: Int): String = when (number) {
        1, 2, 3, 4 -> {
            val final = ('P'.code + number - 1).toChar()
            if (parameter > 1) "\u001b[1;$parameter$final" else "\u001bO$final"
        }
        else -> {
            val code = when (number) {
                5 -> 15
                6 -> 17
                7 -> 18
                8 -> 19
                9 -> 20
                10 -> 21
                11 -> 23
                else -> 24
            }
            // Shift is already embedded in xtermParameter; for F5-F12 xterm uses
            // the modifier set `ESC [ code ; m ~`, so pass it through directly.
            if (parameter > 1) "\u001b[$code;${parameter}~" else "\u001b[$code~"
        }
    }
}
