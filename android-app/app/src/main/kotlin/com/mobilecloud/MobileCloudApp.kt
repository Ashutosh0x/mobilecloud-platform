package com.mobilecloud

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.mobilecloud.core.NodeModeState
import com.mobilecloud.core.TradingEngineController
import com.mobilecloud.security.HardwareAttestation
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

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        // Bind the application context so the hardware anchor + Soroban
        // Ed25519 identity are persisted across launches.
        HardwareAttestation.install(this)
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
                description = "Device telemetry, PoR pulls and CloudShell supervision"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }
}
