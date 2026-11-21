package com.mobilecloud.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.ShowChart
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
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
import com.mobilecloud.ui.screens.OnboardingScreen
import com.mobilecloud.ui.screens.SecurityScreen
import com.mobilecloud.ui.theme.Aurora
import com.mobilecloud.ui.theme.MobileCloudTheme

/**
 * Main shell — Aurora Console edition (reference bottom bar: dark floating
 * capsule with the active item in a glowing purple pill, icons above labels).
 *
 * The biometric App Lock stays the outermost render condition (FragmentActivity
 * required by BiometricPrompt; the gate re-arms after 60 s in background).
 */
class MainActivity : FragmentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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
                    else -> Surface(
                        modifier = Modifier.fillMaxSize(),
                        color = Aurora.Bg,
                    ) {
                        OnboardingScreen(onComplete = { provisioned = true })
                    }
                }
            }
        }
    }
}

private enum class Tab(val label: String, val icon: ImageVector) {
    DASHBOARD("Dashboard", Icons.Filled.ShowChart),
    SECURITY("Security", Icons.Filled.Shield),
    SHELL("CloudShell", Icons.Filled.GridView),
    SETTINGS("Settings", Icons.Filled.Settings),
}

@Composable
private fun AppShell() {
    var selected by remember { mutableIntStateOf(Tab.DASHBOARD.ordinal) }
    val tabs = Tab.entries

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(Aurora.Bg, Aurora.Bg, Aurora.BgDeep)
                )
            )
    ) {
        // Screen body with cross-fade/slide transition.
        AnimatedContent(
            targetState = selected,
            modifier = Modifier.fillMaxSize(),
            transitionSpec = {
                (fadeIn(tween(220)) + slideInVertically(tween(220)) { it / 24 })
                    .togetherWith(fadeOut(tween(160)))
            },
            label = "screen",
        ) { idx ->
            when (tabs[idx]) {
                Tab.DASHBOARD -> DashboardScreen()
                Tab.SECURITY -> SecurityScreen()
                Tab.SHELL -> CloudShellScreen()
                Tab.SETTINGS -> HardwareSettingsScreen()
            }
        }

        // Floating reference nav bar.
        AuroraNavBar(
            tabs = tabs,
            selected = selected,
            onSelect = { selected = it },
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(horizontal = 14.dp)
                .padding(bottom = 10.dp + WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() / 2),
        )
    }
}

/**
 * Reference bottom bar: dark capsule, green edge glow, four destinations.
 * The active item is a green pill (Dashboard / Security / CloudShell / Settings).
 */
@Composable
private fun AuroraNavBar(
    tabs: List<Tab>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(26.dp)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Aurora.Card.copy(alpha = 0.96f))
            .border(
                1.dp,
                Brush.horizontalGradient(
                    listOf(
                        Aurora.GlowGreen.copy(alpha = 0.45f),
                        Aurora.Purple.copy(alpha = 0.35f),
                        Aurora.GlowGreen.copy(alpha = 0.45f),
                    )
                ),
                shape,
            )
            .padding(horizontal = 8.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        tabs.forEachIndexed { index, tab ->
            val active = index == selected
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier
                    .clip(RoundedCornerShape(18.dp))
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                    ) { onSelect(index) }
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            ) {
                Box(
                    modifier = Modifier
                        .then(
                            if (active) Modifier
                                .background(
                                    Brush.verticalGradient(
                                        listOf(Color(0xFF163D2C), Color(0xFF0E2A1C))
                                    ),
                                    RoundedCornerShape(16.dp),
                                )
                                .border(1.dp, Aurora.GlowGreen.copy(alpha = 0.65f), RoundedCornerShape(16.dp))
                            else Modifier
                        )
                        .padding(horizontal = 14.dp, vertical = 6.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        tab.icon,
                        contentDescription = tab.label,
                        tint = if (active) Aurora.GlowGreen else Color(0xFF66738C),
                        modifier = Modifier.size(20.dp),
                    )
                }
                Spacer(Modifier.height(3.dp))
                Text(
                    tab.label,
                    fontSize = 10.sp,
                    fontWeight = if (active) FontWeight.Bold else FontWeight.Medium,
                    color = if (active) Aurora.GlowGreen else Color(0xFF66738C),
                    maxLines = 1,
                )
            }
        }
    }
}
