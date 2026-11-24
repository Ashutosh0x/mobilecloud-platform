package com.mobilecloud.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        startForegroundService(Intent(this, CloudSupervisorService::class.java))
        startForegroundService(Intent(this, NetworkBunderService::class.java))

        val consolePrefs = getSharedPreferences("mobilecloud_console", MODE_PRIVATE)

        setContent {
            MobileCloudTheme {
                var provisioned by remember { mutableStateOf(false) }
                var locked by remember { mutableStateOf(AppLockManager.shouldLock(this)) }

                DisposableEffect(Unit) {
                    val observer = LifecycleEventObserver { _, event ->
                        when (event) {
                            Lifecycle.Event.ON_STOP ->
                                AppLockManager.markBackgrounded(this@MainActivity)
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
                        onUnlocked = { locked = false },
                    )
                    !provisioned -> Surface(
                        modifier = Modifier.fillMaxSize(),
                        color = Aurora.Bg,
                    ) {
                        OnboardingScreen(onComplete = { provisioned = true })
                    }
                    else -> ConsoleRoot(consolePrefs)
                }
            }
        }
    }
}
