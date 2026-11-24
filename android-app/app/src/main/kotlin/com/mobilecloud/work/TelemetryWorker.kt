package com.mobilecloud.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.glance.appwidget.updateAll
import com.mobilecloud.core.TelemetryProvider
import com.mobilecloud.service.BatteryBypassDetector
import com.mobilecloud.widget.EdgeStatusWidget
import com.mobilecloud.widget.WidgetStateStore

/**
 * 15-minute node telemetry heartbeat (GitHub WidgetWorker cadence, tightened
 * for trading data per decompilation report §17.4).
 *
 * Sources: sysfs SoC thermal zone (no JNI dependency in the worker path),
 * BatteryBypassDetector for USB-PD charge-separation state, and the
 * core-engine /mesh/peers endpoint for mesh peer count. Results land in
 * WidgetStateStore and are pushed to the Glance EdgeStatus widget.
 */
class TelemetryWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val tempMilliC = readSocTempMilliC()
        val power = BatteryBypassDetector.probe(applicationContext)
        val meshPeers = fetchMeshPeers()

        WidgetStateStore.updateNode(
            context = applicationContext,
            socTempC = if (tempMilliC >= 0) tempMilliC / 1000.0 else -1.0,
            bypassActive = power.bypassActive,
            batteryPercent = power.batteryPercent,
            meshPeers = meshPeers,
        )
        EdgeStatusWidget().updateAll(applicationContext)
        return Result.success()
    }

    /**
     * Best live CPU/SoC thermal zone in milli-°C, or -1 when none is readable.
     * Reuses the shared probe so the worker applies the same cpu/soc type
     * filter and trip-point exclusion as the dashboard (reading zone0 raw
     * often returns a kernel trip-point constant, or is denied by SELinux).
     */
    private fun readSocTempMilliC(): Int {
        val (celsius, _) = TelemetryProvider.readBestSocTemp()
        return celsius?.let { (it * 1000).toInt() } ?: -1
    }

    /** core-engine mesh peer count; 0 when the daemon is not reachable. */
    private fun fetchMeshPeers(): Int {
        val body = CoreEngineProbe.get("/mesh/peers") ?: return 0
        return Regex("\"active\"\\s*:\\s*(\\d+)").find(body)
            ?.groupValues?.get(1)?.toIntOrNull() ?: 0
    }
}
