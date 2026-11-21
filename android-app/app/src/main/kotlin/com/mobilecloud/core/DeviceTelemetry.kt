package com.mobilecloud.core

import android.app.ActivityManager
import android.content.Context
import android.net.TrafficStats
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import com.mobilecloud.service.BatteryBypassDetector
import java.io.File

/**
 * REAL device telemetry from legitimate Android system interfaces only
 * (audit prompt Phase 2). Every field carries its source. Values the device
 * cannot measure are `null` / "UNAVAILABLE" — never invented.
 *
 * Wall-power draw is deliberately absent: a wall-power figure requires an
 * external measurement source (smart-plug/PDU); Android cannot measure it.
 */
data class DeviceTelemetry(
    // Device identity (Build)
    val deviceModel: String,
    val deviceBoard: String,
    val socModel: String?,
    val androidRelease: String,
    val sdkInt: Int,
    // CPU (sysfs cpufreq)
    val coreCount: Int,
    val coresOnline: Int,
    val currentMaxCoreKHz: Long?,
    val highestCoreMaxKHz: Long?,
    // Uptime (SystemClock — real boot session)
    val uptimeMs: Long,
    // Memory (ActivityManager)
    val memTotalMb: Long,
    val memAvailMb: Long,
    // Storage (StatFs on /data)
    val storageTotalGb: Double,
    val storageFreeGb: Double,
    // Thermal (sysfs thermal zones — best CPU-adjacent zone)
    val socTempC: Double?,
    val socTempSource: String?,
    // Battery (BatteryManager — real readings, no bypass assumption)
    val battery: BatteryBypassDetector.PowerState,
    // Network (TrafficStats since boot)
    val rxBytesSinceBoot: Long?,
    val txBytesSinceBoot: Long?,
    val collectedAtEpochMs: Long,
) {
    val memUsedPct: Int get() =
        if (memTotalMb > 0) (((memTotalMb - memAvailMb) * 100) / memTotalMb).toInt() else 0
    val storageUsedPct: Int get() =
        if (storageTotalGb > 0) (((storageTotalGb - storageFreeGb) * 100) / storageTotalGb).toInt() else 0
}

object TelemetryProvider {

    fun snapshot(context: Context): DeviceTelemetry {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }

        val battery = BatteryBypassDetector.probe(context)
        val (socTemp, tempSource) = readBestSocTemp()

        val stat = runCatching {
            StatFs(Environment.getDataDirectory().absolutePath)
        }.getOrNull()
        val storageTotalGb = stat?.let { it.totalBytes / 1e9 } ?: 0.0
        val storageFreeGb = stat?.let { it.availableBytes / 1e9 } ?: 0.0

        val rx = TrafficStats.getTotalRxBytes().takeIf { it >= 0 }
        val tx = TrafficStats.getTotalTxBytes().takeIf { it >= 0 }

        return DeviceTelemetry(
            deviceModel = Build.MODEL,
            deviceBoard = Build.BOARD,
            socModel = if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL else null,
            androidRelease = Build.VERSION.RELEASE,
            sdkInt = Build.VERSION.SDK_INT,
            coreCount = Runtime.getRuntime().availableProcessors(),
            coresOnline = countCoresOnline(),
            currentMaxCoreKHz = readCores().maxOfOrNull { it.curKHz ?: 0L }?.takeIf { it > 0 },
            highestCoreMaxKHz = readCores().maxOfOrNull { it.maxKHz ?: 0L }?.takeIf { it > 0 },
            uptimeMs = SystemClock.elapsedRealtime(),
            memTotalMb = mem.totalMem / (1024 * 1024),
            memAvailMb = mem.availMem / (1024 * 1024),
            storageTotalGb = storageTotalGb,
            storageFreeGb = storageFreeGb,
            socTempC = socTemp,
            socTempSource = tempSource,
            battery = battery,
            rxBytesSinceBoot = rx,
            txBytesSinceBoot = tx,
            collectedAtEpochMs = System.currentTimeMillis(),
        )
    }

    data class CoreInfo(val index: Int, val online: Boolean, val curKHz: Long?, val maxKHz: Long?)

    fun readCores(): List<CoreInfo> {
        val cores = mutableListOf<CoreInfo>()
        for (i in 0 until Runtime.getRuntime().availableProcessors()) {
            val base = "/sys/devices/system/cpu/cpu$i/cpufreq"
            val online = runCatching {
                File("/sys/devices/system/cpu/cpu$i/online").readText().trim() == "1" ||
                    i == 0 // cpu0 has no online node; always present
            }.getOrDefault(i == 0)
            val cur = readLong("$base/scaling_cur_freq")
            val max = readLong("$base/cpuinfo_max_freq")
            cores.add(CoreInfo(i, online, cur, max))
        }
        return cores
    }

    private fun countCoresOnline(): Int = readCores().count { it.online }

    private fun readLong(path: String): Long? = runCatching {
        File(path).readText().trim().toLongOrNull()
    }.getOrNull()

    /**
     * Best live CPU temperature. Field finding (2026-11-21, device sweetin):
     * zones suffixed -step/-usr/-lowf are kernel TRIP-POINT configs
     * (constants like 44.6°C), not measurements — they must be excluded or
     * the dashboard displays a throttle threshold as live temperature.
     */
    fun readBestSocTemp(): Pair<Double?, String?> {
        val tripPoint = Regex("-(usr|step|lowf|max.*|high|crit)$")
        var bestC: Double? = null
        var bestType: String? = null
        for (zone in 0 until 32) {
            val type = runCatching {
                File("/sys/class/thermal/thermal_zone$zone/type").readText().trim()
            }.getOrNull() ?: continue
            if (!type.startsWith("cpu") && !type.startsWith("soc")) continue
            if (tripPoint.containsMatchIn(type)) continue
            val temp = readLongFile("/sys/class/thermal/thermal_zone$zone/temp") ?: continue
            val c = temp / 1000.0
            if (c in 1.0..119.0 && (bestC == null || c > bestC)) {
                bestC = c
                bestType = type
            }
        }
        return bestC to bestType
    }

    private fun readLongFile(path: String): Long? = runCatching {
        File(path).readText().trim().toLongOrNull()
    }.getOrNull()

    fun formatUptime(ms: Long): String {
        val s = ms / 1000
        val d = s / 86400
        val h = (s % 86400) / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return if (d > 0) "${d}d ${h}h ${m}m" else "${h}h ${m}m ${sec}s"
    }
}
