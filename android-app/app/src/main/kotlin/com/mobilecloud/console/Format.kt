package com.mobilecloud.console

import java.util.Locale

/**
 * Formatting helpers ported 1:1 from the web console `lib/format.ts` so every
 * figure the Android console renders matches the Next.js dashboard exactly.
 */
object Fmt {

    /** `formatBytes` — "—" for null, else B / KB / MB / GB / TB. */
    fun bytes(n: Long?): String {
        if (n == null) return "—"
        if (n < 1024) return "$n B"
        val units = listOf("KB", "MB", "GB", "TB")
        var value = n.toDouble() / 1024.0
        var i = 0
        while (value >= 1024.0 && i < units.size - 1) {
            value /= 1024.0
            i += 1
        }
        val text = if (value >= 10) String.format(Locale.US, "%.0f", value) else String.format(Locale.US, "%.1f", value)
        return "$text ${units[i]}"
    }

    /** `formatDuration` — "2d 3h 4m" / "3h 4m" / "4m 5s". */
    fun duration(sec: Long): String {
        val d = sec / 86400
        val h = (sec % 86400) / 3600
        val m = (sec % 3600) / 60
        val s = sec % 60
        return when {
            d > 0 -> "${d}d ${h}h ${m}m"
            h > 0 -> "${h}h ${m}m"
            else -> "${m}m ${s}s"
        }
    }

    /** `rel` — relative "just now" / "5m ago" / "3h ago" / "2d ago". */
    fun rel(ts: Long): String {
        val delta = (System.currentTimeMillis() - ts).coerceAtLeast(0)
        val min = delta / 60000
        if (min < 1) return "just now"
        if (min < 60) return "${min}m ago"
        val h = min / 60
        if (h < 48) return "${h}h ago"
        return "${h / 24}d ago"
    }
}
