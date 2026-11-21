package com.mobilecloud.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.HealthAndSafety
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Insights
import androidx.compose.material.icons.filled.ShowChart
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.mobilecloud.security.AppLockManager
import com.mobilecloud.service.CloudSupervisorService
import com.mobilecloud.service.NetworkBunderService
import com.mobilecloud.ui.screens.AppLockScreen
import com.mobilecloud.ui.screens.CloudShellScreen
import com.mobilecloud.ui.screens.DashboardScreen
import com.mobilecloud.ui.screens.HardwareSettingsScreen
import com.mobilecloud.ui.screens.MeshScreen
import com.mobilecloud.ui.screens.OnboardingScreen
import com.mobilecloud.ui.screens.ProofOfReserveScreen
import com.mobilecloud.ui.screens.TradingScreen
import com.mobilecloud.ui.theme.MobileCloudTheme
import com.mobilecloud.ui.theme.TextSecondary

/**
 * Main bottom-navigation shell (CIDS spec section 2 — six screen modules +
 * the onboarding gate from Flow Step 1).
 *
 * Hosts the biometric App Lock as the outermost render condition (GitHub
 * AppLockActivity pattern, decompilation report §11.2): FragmentActivity is
 * required by BiometricPrompt, and the gate re-arms after 60 s in background
 * via the ON_STOP/ON_START lifecycle observer.
 */
class MainActivity : FragmentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Pin the foreground supervisor + dual-WAN transport on entry.
        startForegroundService(Intent(this, CloudSupervisorService::class.java))
        startForegroundService(Intent(this, NetworkBunderService::class.java))

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
                    provisioned -> AppShell()
                    else -> Surface(modifier = Modifier.fillMaxSize()) {
                        OnboardingScreen(onComplete = { provisioned = true })
                    }
                }
            }
        }
    }
}

private enum class Tab(val label: String, val icon: ImageVector) {
    DASHBOARD("Dashboard", Icons.Filled.Insights),
    TRADING("Trading", Icons.Filled.ShowChart),
    POR("PoR Oracle", Icons.Filled.HealthAndSafety),
    SHELL("CloudShell", Icons.Filled.Terminal),
    MESH("Mesh", Icons.Filled.Hub),
    SAFETY("Safety", Icons.Filled.HealthAndSafety),
}

@Composable
private fun AppShell() {
    var selected by remember { mutableIntStateOf(Tab.DASHBOARD.ordinal) }
    val tabs = Tab.entries

    Scaffold(
        bottomBar = {
            NavigationBar {
                tabs.forEachIndexed { index, tab ->
                    NavigationBarItem(
                        selected = selected == index,
                        onClick = { selected = index },
                        icon = { Icon(tab.icon, contentDescription = tab.label) },
                        label = { Text(tab.label, fontSize = 10.sp, color = TextSecondary) },
                    )
                }
            }
        },
    ) { padding ->
        Surface(modifier = Modifier.fillMaxSize().padding(padding)) {
            when (tabs[selected]) {
                Tab.DASHBOARD -> DashboardScreen()
                Tab.TRADING -> TradingScreen()
                Tab.POR -> ProofOfReserveScreen()
                Tab.SHELL -> CloudShellScreen()
                Tab.MESH -> MeshScreen()
                Tab.SAFETY -> HardwareSettingsScreen()
            }
        }
    }
}
