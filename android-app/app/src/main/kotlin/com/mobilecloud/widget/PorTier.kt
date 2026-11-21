package com.mobilecloud.widget

/**
 * Proof-of-Reserve tier mapping shared by [PorSolvencyWidget] and the app UI
 * (master blueprint §3 — five-tier governance; GLANCE-side copy because Glance
 * cannot consume Compose MaterialTheme enums from the ui.components module).
 */
enum class PorTier(val label: String, val argb: Long) {
    HEALTHY("HEALTHY", 0xFF10B981),
    WARNING("WARNING", 0xFFF59E0B),
    STALE("STALE", 0xFFF97316),
    CRITICAL("CRITICAL", 0xFFEF4444),
    FROZEN("FROZEN", 0xFFA855F7),
    NO_DATA("NO DATA", 0xFF64748B),
}

fun porTierFor(snapshot: WidgetSnapshot, nowEpochMs: Long = System.currentTimeMillis()): PorTier {
    if (snapshot.backingRatio < 0.0) return PorTier.NO_DATA
    if (snapshot.isPorStale(nowEpochMs)) return PorTier.STALE
    return when {
        snapshot.backingRatio >= 100.0 -> PorTier.HEALTHY
        snapshot.backingRatio >= 99.50 -> PorTier.WARNING
        else -> PorTier.CRITICAL
    }
}
