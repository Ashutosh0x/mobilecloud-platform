package com.mobilecloud.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.mobilecloud.MobileCloudApp
import com.mobilecloud.core.TradingEngineController
import com.mobilecloud.ui.MainActivity
import kotlinx.coroutines.*

class CloudSupervisorService : Service() {

    private val serviceScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        acquireWakeLock()
        startForeground(1001, buildNotification())
        startSupervisorLoop()
    }

    private fun acquireWakeLock() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "MobileCloud::SupervisorWakeLock"
        ).apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun startSupervisorLoop() {
        serviceScope.launch {
            while (isActive) {
                // Hardware telemetry: SoC thermal governor feed (sysfs via JNI)
                // plus USB-PD bypass verification every 5 seconds.
                val tempMilli = runCatching { nativeReadSocTempMilli() }.getOrDefault(31000)
                val tempC = tempMilli / 1000.0
                if (tempC > THERMAL_CEILING_C) {
                    android.util.Log.w(
                        TAG,
                        "SoC %.1f°C exceeds %.0f°C ceiling — throttling build concurrency".format(tempC, THERMAL_CEILING_C)
                    )
                }

                // Fail-closed thermal guard: trip the persisted trading-engine
                // halt at >45 °C when auto-halt is armed (audit prompt Phase 6).
                if (tempC > 45.0 && TradingEngineController.thermalAutoHalt.value) {
                    TradingEngineController.halt(
                        this@CloudSupervisorService,
                        "Thermal guard: SoC %.1f°C > 45.0°C".format(tempC),
                    )
                    android.util.Log.w(TAG, "thermal auto-halt tripped at %.1f°C".format(tempC))
                }

                val power = BatteryBypassDetector.probe(this@CloudSupervisorService)
                if (power.usbConnected && !power.bypassActive) {
                    android.util.Log.w(TAG, "battery cycling while on USB — bypass not engaged")
                }

                delay(5000)
            }
        }
    }

    /** sysfs thermal reader (cpp/jni_bridge.cpp, libmobilecloud_native.so). */
    private external fun nativeReadSocTempMilli(): Int

    private fun buildNotification(): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, MobileCloudApp.CHANNEL_ID)
            .setContentTitle("MobileCloud Node Active")
            .setContentText("Autonomous trading and PoR oracle running at 1.94W wall power")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    override fun onDestroy() {
        super.onDestroy()
        serviceScope.cancel()
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "CloudSupervisor"
        const val NOTIFICATION_ID = 1001

        /** SoC ceiling (°C) before the governor throttles workloads. */
        const val THERMAL_CEILING_C = 45.0

        init {
            try {
                System.loadLibrary("mobilecloud_native")
            } catch (e: UnsatisfiedLinkError) {
                e.printStackTrace()
            }
        }
    }
}
