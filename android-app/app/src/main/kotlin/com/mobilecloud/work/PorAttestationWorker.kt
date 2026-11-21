package com.mobilecloud.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.glance.appwidget.updateAll
import com.mobilecloud.widget.PorSolvencyWidget
import com.mobilecloud.widget.WidgetStateStore

/**
 * Hourly Proof-of-Reserve attestation pull (GitHub PullRequestsWidgetWorker
 * cadence — decompilation report §12.1).
 *
 * Fetches the reconciled backing ratio + evidence age from the por-kernel
 * daemon (`GET /api/por/attestation`, RFC 8785 envelope summaries), stores it
 * for the PoR widget, and pushes a Glance update. Tier coloring happens at
 * render time in [com.mobilecloud.widget.porTierFor].
 */
class PorAttestationWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val body = CoreEngineProbe.get("/api/por/attestation")
        if (body != null) {
            val ratio = Regex("\"backing_ratio\"\\s*:\\s*([0-9.]+)")
                .find(body)?.groupValues?.get(1)?.toDoubleOrNull()
            val ageMinutes = Regex("\"evidence_age_minutes\"\\s*:\\s*([0-9]+)")
                .find(body)?.groupValues?.get(1)?.toLongOrNull()
            if (ratio != null && ageMinutes != null) {
                WidgetStateStore.updatePor(applicationContext, ratio, ageMinutes)
            }
        }
        // Even without a fresh pull, re-render so evidence-age staleness
        // (> 4 h → STALE tier) is reflected in the widget.
        PorSolvencyWidget().updateAll(applicationContext)
        return Result.success()
    }
}
