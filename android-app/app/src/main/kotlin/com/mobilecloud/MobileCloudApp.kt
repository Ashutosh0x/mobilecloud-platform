package com.mobilecloud

import android.app.Application
import com.mobilecloud.security.HardwareAttestation
import com.mobilecloud.work.WorkerScheduler

class MobileCloudApp : Application() {
    override fun onCreate() {
        super.onCreate()
        HardwareAttestation.install(this)
        WorkerScheduler.cancelLegacyNodeWork(this)
        // The console never launches a local daemon. Drop its old plaintext
        // webhook credential and status cache on upgrade.
        deleteSharedPreferences("core_runtime")
    }
}
