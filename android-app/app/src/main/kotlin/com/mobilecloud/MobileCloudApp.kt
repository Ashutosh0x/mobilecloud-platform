package com.mobilecloud

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.mobilecloud.core.NodeModeState
import com.mobilecloud.core.TradingEngineController
import com.mobilecloud.work.WorkerScheduler

class MobileCloudApp : Application() {

    companion object {
        const val CHANNEL_ID = "mobilecloud_supervisor_channel"

        init {
            try {
                System.loadLibrary("mobilecloud_native")
            } catch (e: UnsatisfiedLinkError) {
                e.printStackTrace()
            }
        }
    }

    external fun getKernelVersion(): String

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        // Honesty layer + fail-closed engine state: persisted mode and halt
        // state are loaded before any UI can render.
        NodeModeState.load(this)
        TradingEngineController.load(this)
        // All background work in WorkManager CoroutineWorkers (GitHub pattern,
        // decompilation report §17.3 #3): thermal telemetry every 15 min,
        // PoR attestation pull hourly. Idempotent via KEEP policy.
        WorkerScheduler.scheduleAll(this)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "MobileCloud Edge Supervisor",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "24/7 background telemetry and blockchain arbitrage supervisor"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }
}
