package com.mobilecloud.work

import android.content.Context
import androidx.work.WorkManager

/** Upgrade cleanup for releases that scheduled node work on every launch. */
object WorkerScheduler {
    fun cancelLegacyNodeWork(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.cancelUniqueWork("thermal_guardian")
        wm.cancelUniqueWork("por_attestation")
    }
}
