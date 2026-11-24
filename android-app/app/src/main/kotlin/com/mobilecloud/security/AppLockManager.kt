package com.mobilecloud.security

import android.content.Context
import android.os.SystemClock

/** Device-local UI privacy gate. It does not authorize keys or API requests. */
object AppLockManager {
    private const val PREFS = "app_lock"
    private const val KEY_ENABLED = "enabled"
    private const val AUTO_LOCK_TIMEOUT_MS = 60_000L

    // In-memory only: an enabled app lock always prompts after process death.
    // A new authentication, not another brief foreground visit, resets grace.
    private var authenticated = false
    private var graceDeadlineMs: Long? = null

    fun isEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_ENABLED, false)

    fun setEnabled(context: Context, enabled: Boolean) {
        authenticated = false
        graceDeadlineMs = null
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply()
    }

    fun markBackgrounded() {
        if (authenticated && graceDeadlineMs == null) {
            graceDeadlineMs = SystemClock.elapsedRealtime() + AUTO_LOCK_TIMEOUT_MS
        }
    }

    fun markUnlocked() {
        authenticated = true
        graceDeadlineMs = null
    }

    fun shouldLock(context: Context): Boolean {
        if (!isEnabled(context)) return false
        val deadline = graceDeadlineMs
        if (deadline != null && SystemClock.elapsedRealtime() >= deadline) authenticated = false
        return !authenticated
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
