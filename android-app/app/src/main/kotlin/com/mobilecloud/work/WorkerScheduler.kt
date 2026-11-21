package com.mobilecloud.work

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Central periodic-schedule registry (GitHub pattern: all background work in
 * WorkManager CoroutineWorkers — never raw Services or AlarmManager —
 * decompilation report §17.3 #3).
 *
 * | Worker                | Cadence   | Uniquename        |
 * |-----------------------|-----------|-------------------|
 * | TelemetryWorker       | 15 min    | thermal_guardian  |
 * | PorAttestationWorker  | 1 hour    | por_attestation   |
 *
 * KEEP policy: schedules are stable across app restarts and reboots (the
 * supervisor's boot receiver re-runs scheduling idempotently).
 */
object WorkerScheduler {

    private const val UNIQUE_TELEMETRY = "thermal_guardian"
    private const val UNIQUE_POR = "por_attestation"

    fun scheduleAll(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.enqueueUniquePeriodicWork(
            UNIQUE_TELEMETRY,
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<TelemetryWorker>(15, TimeUnit.MINUTES).build(),
        )
        wm.enqueueUniquePeriodicWork(
            UNIQUE_POR,
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<PorAttestationWorker>(1, TimeUnit.HOURS).build(),
        )
    }
}
