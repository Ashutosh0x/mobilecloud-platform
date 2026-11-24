package com.mobilecloud.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.mobilecloud.security.AppLockManager
import com.mobilecloud.service.CloudSupervisorService
import com.mobilecloud.service.NetworkBunderService
import com.mobilecloud.ui.console.ConsoleRoot
import com.mobilecloud.ui.screens.AppLockScreen
import com.mobilecloud.ui.screens.OnboardingScreen
import com.mobilecloud.ui.theme.Aurora
import com.mobilecloud.ui.theme.MobileCloudTheme

/**
 * Main entry — the full web-parity console ([ConsoleRoot]) rendered on Android.
 *
 * The biometric App Lock stays the outermost render condition (FragmentActivity
 * required by BiometricPrompt; the gate re-arms after 60 s in background), and
 * the one-time onboarding runs before the console mounts.
 */
class MainActivity : FragmentActivity() {

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        startForegroundService(Intent(this, CloudSupervisorService::class.java))
        startForegroundService(Intent(this, NetworkBunderService::class.java))
        requestNotificationPermissionIfNeeded()

        val consolePrefs = getSharedPreferences("mobilecloud_console", MODE_PRIVATE)
        val bootstrapPrefs = getSharedPreferences("mobilecloud_bootstrap", MODE_PRIVATE)

        setContent {
            MobileCloudTheme {
                var provisioned by remember {
                    mutableStateOf(bootstrapPrefs.getBoolean(KEY_PROVISIONED, false))
                }
                var locked by remember { mutableStateOf(AppLockManager.shouldLock(this)) }

                DisposableEffect(Unit) {
                    val observer = LifecycleEventObserver { _, event ->
                        when (event) {
                            Lifecycle.Event.ON_STOP ->
                                // A configuration change (e.g. rotation) also
                                // stops and recreates the activity, but it is
                                // not a real backgrounding: skip re-arming the
                                // lock so the screen does not re-prompt.
                                if (!isChangingConfigurations) {
                                    AppLockManager.markBackgrounded(this@MainActivity)
                                }
                            Lifecycle.Event.ON_START ->
                                if (AppLockManager.shouldLock(this@MainActivity)) locked = true
                            else -> {}
                        }
                    }
                    lifecycle.addObserver(observer)
                    onDispose { lifecycle.removeObserver(observer) }
                }

                when {
                    locked -> AppLockScreen(
                        activity = this@MainActivity,
                        onUnlocked = {
                            AppLockManager.markUnlocked(this@MainActivity)
                            locked = false
                        },
                    )
                    !provisioned -> Surface(
                        modifier = Modifier.fillMaxSize(),
                        color = Aurora.Bg,
                    ) {
                        OnboardingScreen(onComplete = {
                            bootstrapPrefs.edit().putBoolean(KEY_PROVISIONED, true).apply()
                            provisioned = true
                        })
                    }
                    else -> ConsoleRoot(consolePrefs)
                }
            }
        }
    }

    /** API 33+ requires an explicit grant before the supervisors can post. */
    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return
        val granted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private companion object {
        const val KEY_PROVISIONED = "provisioning_complete"
    }
}
