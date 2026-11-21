package com.mobilecloud.core

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Operating-mode honesty layer (master audit prompt Phase 9 / Phase 11).
 *
 * Every subsystem operates in exactly one of three declared modes and the UI
 * must make it impossible to confuse them:
 *
 *  LIVE       — real integrations, verified connectivity, actual operations.
 *  SIMULATION — clearly-labelled simulated/specimen operations. DEFAULT.
 *  DEGRADED   — real integrations attempted but a dependency is unavailable.
 *
 * The mode is persisted and never switches silently: every screen renders the
 * banner from [NodeModeState] before any metric cards.
 */
enum class OperatingMode(val label: String) {
    LIVE("LIVE"),
    SIMULATION("SIMULATION"),
    DEGRADED("DEGRADED"),
}

object NodeModeState {

    private const val PREFS = "node_mode"
    private const val KEY_MODE = "operating_mode"

    private val _mode = MutableStateFlow(OperatingMode.SIMULATION)
    val mode: StateFlow<OperatingMode> = _mode

    fun load(context: Context) {
        val saved = prefs(context).getString(KEY_MODE, OperatingMode.SIMULATION.name)
        _mode.value = runCatching { OperatingMode.valueOf(saved!!) }
            .getOrDefault(OperatingMode.SIMULATION)
    }

    /** Mode changes are deliberate user actions — never automatic, never silent. */
    fun set(context: Context, mode: OperatingMode) {
        prefs(context).edit().putString(KEY_MODE, mode.name).apply()
        _mode.value = mode
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}

/**
 * Emergency-stop controller for the trading engine (audit prompt Phase 3).
 *
 * Fail-closed contract:
 *  - [halted] persists across process restarts (SharedPreferences).
 *  - Any future order-submission path MUST call [requireClear] and abort on
 *    exception — no execution can happen while halted, regardless of UI.
 *  - Thermal auto-halt (supervisor loop) writes here too, so an overheat
 *    halts the engine even when no screen is open.
 *  - Resuming requires an explicit [resume] call (UI long-press release).
 */
object TradingEngineController {

    data class HaltState(
        val halted: Boolean,
        val reason: String,
        val haltedAtEpochMs: Long,
    )

    private const val PREFS = "engine_state"
    private const val KEY_HALTED = "halted"
    private const val KEY_REASON = "halt_reason"
    private const val KEY_HALTED_AT = "halted_at"
    private const val KEY_THERMAL_AUTOHALT = "thermal_autohalt"

    private val _state = MutableStateFlow(HaltState(false, "", 0L))
    val state: StateFlow<HaltState> = _state

    private val _thermalAutoHalt = MutableStateFlow(true)
    val thermalAutoHalt: StateFlow<Boolean> = _thermalAutoHalt

    fun load(context: Context) {
        val p = prefs(context)
        _state.value = HaltState(
            halted = p.getBoolean(KEY_HALTED, false),
            reason = p.getString(KEY_REASON, "") ?: "",
            haltedAtEpochMs = p.getLong(KEY_HALTED_AT, 0L),
        )
        _thermalAutoHalt.value = p.getBoolean(KEY_THERMAL_AUTOHALT, true)
    }

    fun halt(context: Context, reason: String) {
        if (_state.value.halted) return
        val s = HaltState(true, reason, System.currentTimeMillis())
        prefs(context).edit()
            .putBoolean(KEY_HALTED, true)
            .putString(KEY_REASON, reason)
            .putLong(KEY_HALTED_AT, s.haltedAtEpochMs)
            .apply()
        _state.value = s
    }

    /** Explicit operator authorization required to resume. */
    fun resume(context: Context) {
        prefs(context).edit()
            .putBoolean(KEY_HALTED, false)
            .putString(KEY_REASON, "")
            .putLong(KEY_HALTED_AT, 0L)
            .apply()
        _state.value = HaltState(false, "", 0L)
    }

    fun setThermalAutoHalt(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_THERMAL_AUTOHALT, enabled).apply()
        _thermalAutoHalt.value = enabled
    }

    /** Fail-closed gate: throws when halted; call before any submission path. */
    fun requireClear() {
        val s = _state.value
        check(!s.halted) { "Trading engine halted: ${s.reason}. Explicit resume required." }
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
