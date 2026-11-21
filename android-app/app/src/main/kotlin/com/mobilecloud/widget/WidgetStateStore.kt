package com.mobilecloud.widget

import android.content.Context

/**
 * Shared persistence between the background workers and the Glance widgets
 * (GitHub pattern: workers write `WidgetUIState`, widgets render it —
 * decompilation report §7, Kotlin Serialization widget state; this store is
 * the dependency-free SharedPreferences equivalent).
 */
data class WidgetSnapshot(
    val socTempC: Double,
    val bypassActive: Boolean,
    val batteryPercent: Int,
    val meshPeers: Int,
    val backingRatio: Double,
    val evidenceAgeMinutes: Long,
    val nodeUpdatedAtEpochMs: Long,
    val porUpdatedAtEpochMs: Long,
) {
    /** Telemetry is fresh only if a worker heartbeat landed inside the window. */
    fun isNodeOnline(nowEpochMs: Long = System.currentTimeMillis()): Boolean =
        socTempC >= 0.0 && nowEpochMs - nodeUpdatedAtEpochMs < NODE_FRESHNESS_WINDOW_MS

    /** PoR evidence turns STALE past the 4-hour ceiling (master blueprint §3). */
    fun isPorStale(nowEpochMs: Long = System.currentTimeMillis()): Boolean =
        (nowEpochMs - porUpdatedAtEpochMs) / 60_000L > POR_STALE_MINUTES

    companion object {
        const val NODE_FRESHNESS_WINDOW_MS = 15 * 60_000L
        const val POR_STALE_MINUTES = 240L
    }
}

object WidgetStateStore {

    private const val PREFS = "widget_state"
    private const val KEY_SOC_TEMP_MILLI = "soc_temp_milli_c"
    private const val KEY_BYPASS = "bypass_active"
    private const val KEY_BATTERY_PCT = "battery_percent"
    private const val KEY_MESH_PEERS = "mesh_peers"
    private const val KEY_BACKING_RATIO = "backing_ratio"
    private const val KEY_EVIDENCE_AGE = "evidence_age_minutes"
    private const val KEY_NODE_UPDATED = "node_updated_at"
    private const val KEY_POR_UPDATED = "por_updated_at"

    fun updateNode(
        context: Context,
        socTempC: Double,
        bypassActive: Boolean,
        batteryPercent: Int,
        meshPeers: Int,
    ) {
        prefs(context).edit()
            .putInt(KEY_SOC_TEMP_MILLI, (socTempC * 1000).toInt())
            .putBoolean(KEY_BYPASS, bypassActive)
            .putInt(KEY_BATTERY_PCT, batteryPercent)
            .putInt(KEY_MESH_PEERS, meshPeers)
            .putLong(KEY_NODE_UPDATED, System.currentTimeMillis())
            .apply()
    }

    fun updatePor(context: Context, backingRatio: Double, evidenceAgeMinutes: Long) {
        prefs(context).edit()
            .putFloat(KEY_BACKING_RATIO, backingRatio.toFloat())
            .putLong(KEY_EVIDENCE_AGE, evidenceAgeMinutes)
            .putLong(KEY_POR_UPDATED, System.currentTimeMillis())
            .apply()
    }

    fun snapshot(context: Context): WidgetSnapshot {
        val p = prefs(context)
        return WidgetSnapshot(
            socTempC = p.getInt(KEY_SOC_TEMP_MILLI, Int.MIN_VALUE).let {
                if (it == Int.MIN_VALUE) -1.0 else it / 1000.0
            },
            bypassActive = p.getBoolean(KEY_BYPASS, false),
            batteryPercent = p.getInt(KEY_BATTERY_PCT, 0),
            meshPeers = p.getInt(KEY_MESH_PEERS, 0),
            backingRatio = p.getFloat(KEY_BACKING_RATIO, -1f).toDouble(),
            evidenceAgeMinutes = p.getLong(KEY_EVIDENCE_AGE, 0L),
            nodeUpdatedAtEpochMs = p.getLong(KEY_NODE_UPDATED, 0L),
            porUpdatedAtEpochMs = p.getLong(KEY_POR_UPDATED, 0L),
        )
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
