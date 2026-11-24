package com.mobilecloud.security

import android.content.Context

/**
 * Biometric App Lock gate (GitHub App pattern, decompilation report §11.2 /
 * §17.3 #10 — MobileCloud adaptation).
 *
 * GitHub ships an AppLockActivity (singleTask) + AppLockSettingsActivity pair
 * gated on USE_BIOMETRIC; the MobileCloud node carries the same gate because
 * the device is a 24/7 kiosk running financial compute — trades, PoR
 * attestations and CloudShell sessions must not be arm's-reach accessible.
 *
 * The gate is the outermost render condition in MainActivity (above
 * onboarding), re-arming after [AUTO_LOCK_TIMEOUT_MS] in background.
 */
object AppLockManager {

    private const val PREFS = "app_lock"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_LAST_BACKGROUNDED = "last_backgrounded_epoch_ms"

    /** Re-lock threshold after the activity leaves the foreground (GitHub: 60 s). */
    const val AUTO_LOCK_TIMEOUT_MS = 60_000L

    /**
     * In-memory result of a successful unlock for the current foreground
     * session. Because the process survives a configuration change (rotation),
     * a recreate caused by rotation still sees [sessionUnlocked] == true and
     * does not re-prompt; a genuine background→foreground transition resets it
     * in [markBackgrounded], so the gate re-arms.
     */
    @Volatile
    private var sessionUnlocked: Boolean = false

    fun isEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_ENABLED, false)

    fun setEnabled(context: Context, enabled: Boolean) {
        if (!enabled) sessionUnlocked = false
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply()
    }

    /** Record foreground exit; called from the ON_STOP lifecycle observer. */
    fun markBackgrounded(context: Context) {
        sessionUnlocked = false
        prefs(context).edit()
            .putLong(KEY_LAST_BACKGROUNDED, System.currentTimeMillis())
            .apply()
    }

    /**
     * Called when a biometric / device-credential unlock succeeds. Marks the
     * session unlocked and clears the persisted background timestamp so the
     * stale timestamp can never trigger a spurious lock (e.g. after a later
     * rotation recreates the activity).
     */
    fun markUnlocked(context: Context) {
        sessionUnlocked = true
        prefs(context).edit().remove(KEY_LAST_BACKGROUNDED).apply()
    }

    /**
     * True when the gate must be shown: lock enabled, no active unlocked
     * session, and (cold start or the background dwell exceeded
     * [AUTO_LOCK_TIMEOUT_MS]).
     */
    fun shouldLock(context: Context): Boolean {
        if (!isEnabled(context)) return false
        if (sessionUnlocked) return false
        val last = prefs(context).getLong(KEY_LAST_BACKGROUNDED, 0L)
        return last == 0L ||
            System.currentTimeMillis() - last > AUTO_LOCK_TIMEOUT_MS
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
