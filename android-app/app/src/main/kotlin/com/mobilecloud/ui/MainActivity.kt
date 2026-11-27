package com.mobilecloud.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.fragment.app.FragmentActivity
import com.mobilecloud.auth.AuthRequestIntent
import com.mobilecloud.auth.LoginApprovalRequest
import com.mobilecloud.security.AppLockManager
import com.mobilecloud.ui.console.ConsoleRoot
import com.mobilecloud.ui.screens.AppLockScreen
import com.mobilecloud.ui.theme.MobileCloudTheme

/** The console client does not provision a node or request service permissions. */
class MainActivity : FragmentActivity() {
    private var locked by mutableStateOf(false)
    private var approval by mutableStateOf<LoginApprovalRequest?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        locked = AppLockManager.shouldLock(this)
        approval = AuthRequestIntent.read(intent)
        val consolePrefs = getSharedPreferences("mobilecloud_console", MODE_PRIVATE)

        setContent {
            MobileCloudTheme {
                if (locked) {
                    AppLockScreen(activity = this@MainActivity, onUnlocked = {
                        AppLockManager.markUnlocked()
                        locked = false
                    })
                } else {
                    ConsoleRoot(
                        prefs = consolePrefs,
                        approval = approval,
                        onApprovalHandled = { approval = null },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        approval = AuthRequestIntent.read(intent)
    }

    override fun onStart() {
        super.onStart()
        locked = AppLockManager.shouldLock(this)
    }

    override fun onStop() {
        if (!isChangingConfigurations) AppLockManager.markBackgrounded()
        super.onStop()
    }
}
