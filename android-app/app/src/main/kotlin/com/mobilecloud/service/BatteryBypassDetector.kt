package com.mobilecloud.service

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

/**
 * USB-PD PPS Direct Motherboard Power probe (master blueprint §2).
 *
 * Bypass charging ("charge separation") is detected exactly as in the power
 * mathematics doc §8.2: USB input present while the battery FET is open —
 * externally observable as battery status "Not charging" or "Full" with a
 * battery current of **0.00 mA**.
 *
 * Vendor surfaces (Samsung "Pause USB PD", ROG bypass, Sony H.S.) all
 * converge on this sysfs/BatteryManager state, so the detector needs no
 * per-OEM code paths for *detection* — only for *activation* (see
 * HardwareSafetyScreen).
 */
object BatteryBypassDetector {

    data class PowerState(
        val usbConnected: Boolean,
        val batteryStatus: String,
        /** Measured battery current in µA (0 = the bypass goal). */
        val batteryCurrentMicroAmps: Int,
        val batteryPercent: Int,
        val batteryTempTenthsC: Int,
        /** True when USB power feeds the motherboard with the battery isolated. */
        val bypassActive: Boolean,
    )

    fun probe(context: Context): PowerState {
        val battery = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager

        val sticky = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = sticky?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val plugged = sticky?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val level = sticky?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = sticky?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val temp = sticky?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 234) ?: 234

        val usbConnected = plugged == BatteryManager.BATTERY_PLUGGED_USB ||
            plugged == BatteryManager.BATTERY_PLUGGED_AC ||
            plugged == BatteryManager.BATTERY_PLUGGED_DOCK

        val statusText = when (status) {
            BatteryManager.BATTERY_STATUS_CHARGING -> "Charging"
            BatteryManager.BATTERY_STATUS_DISCHARGING -> "Discharging"
            BatteryManager.BATTERY_STATUS_FULL -> "Full"
            BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "Not charging"
            else -> "Unknown"
        }

        // BATTERY_PROPERTY_CURRENT_NOW: positive = charging, negative =
        // discharging, ~0 while the PMIC routes USB power directly to the board.
        val currentMicroAmps =
            battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)

        val batteryIsolated = status == BatteryManager.BATTERY_STATUS_NOT_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        val nearZeroCurrent = kotlin.math.abs(currentMicroAmps) < 150_000 // < 150 mA

        return PowerState(
            usbConnected = usbConnected,
            batteryStatus = statusText,
            batteryCurrentMicroAmps = currentMicroAmps,
            batteryPercent = if (level >= 0 && scale > 0) level * 100 / scale else 0,
            batteryTempTenthsC = temp,
            bypassActive = usbConnected && batteryIsolated && nearZeroCurrent,
        )
    }
}
