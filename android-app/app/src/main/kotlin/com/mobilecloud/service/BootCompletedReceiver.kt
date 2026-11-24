package com.mobilecloud.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class BootCompletedReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            // BOOT_COMPLETED is an allowed exemption for starting a foreground
            // service from the background, so both supervisors come back up
            // with the same behaviour MainActivity requests at launch.
            start(context, CloudSupervisorService::class.java)
            start(context, NetworkBunderService::class.java)
        }
    }

    private fun start(context: Context, service: Class<*>) {
        val serviceIntent = Intent(context, service)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }
    }
}
