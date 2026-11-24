package com.mobilecloud.ui.console

import android.content.SharedPreferences
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.console.ConsoleStatus
import com.mobilecloud.console.ConsoleStore
import com.mobilecloud.ui.theme.AppFonts
import com.mobilecloud.ui.theme.Aurora
import kotlinx.coroutines.launch

/**
 * Web-parity console entry point. Renders the login card until a session
 * exists, then the [ConsoleShell]. Mirrors `app/login/page.tsx` +
 * `components/Shell.tsx` combined into one mobile flow.
 */
@Composable
fun ConsoleRoot(prefs: SharedPreferences? = null) {
    val scope = rememberCoroutineScope()
    // The store needs a Context to watch connectivity changes, so a Wi-Fi ↔
    // mobile-data switch reconnects the socket instead of looking "offline".
    val context = LocalContext.current.applicationContext
    val store = remember { ConsoleStore(scope, prefs, context) }
    LaunchedEffect(Unit) { store.start() }
    DisposableEffect(Unit) { onDispose { store.stop() } }

    when {
        store.status == ConsoleStatus.LOADING -> LoadingSplash()
        store.snapshot == null -> ConsoleLogin(store)
        else -> ConsoleShell(store)
    }
}

@Composable
fun ConsoleLogin(store: ConsoleStore) {
    val scope = rememberCoroutineScope()
    var mode by remember { mutableStateOf("login") }
    var url by remember { mutableStateOf(store.baseUrl) }
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf(false) }

    fun submit() {
        if (pending) return
        pending = true
        error = null
        scope.launch {
            try {
                if (url.isNotBlank()) store.applyBaseUrl(url)
                // No address (or a stale one)? Find the control plane before signing in.
                if (store.baseUrl.isBlank() && store.autoDetect() == null) {
                    error = ConsoleStore.NO_PLANE
                    return@launch
                }
                store.login(if (mode == "signup") "auth/signup" else "auth/login", email, password, name)
            } catch (e: Exception) {
                error = e.message ?: "Sign-in failed"
            } finally {
                pending = false
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(Aurora.Bg)
            .verticalScroll(rememberScrollState())
            .padding(top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding())
            .padding(horizontal = 18.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(30.dp))
        Box(Modifier.height(48.dp).width(48.dp).clip(RoundedCornerShape(12.dp)).background(Aurora.TextHi), Alignment.Center) {
            Text("M", color = Aurora.Bg, fontSize = 24.sp, fontWeight = FontWeight.Bold, fontFamily = AppFonts.Mono)
        }
        Spacer(Modifier.height(14.dp))
        Text("MobileCloud", color = Aurora.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp)
        Spacer(Modifier.height(4.dp))
        Text("Build. Ship. Scale.", color = Aurora.TextMid, fontSize = 12.sp)
        Spacer(Modifier.height(22.dp))

        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(Aurora.Card)
                .border(1.dp, Aurora.Border, RoundedCornerShape(14.dp))
                .padding(18.dp),
        ) {
            Text(
                "Create an account on this server. The first account is the owner. Nothing here is billed.",
                color = Aurora.TextMid, fontSize = 12.sp,
            )
            Spacer(Modifier.height(14.dp))
            RangeTabs(listOf("Create account", "Sign in"), if (mode == "signup") "Create account" else "Sign in", {
                mode = if (it == "Create account") "signup" else "login"
            })
            Spacer(Modifier.height(14.dp))

            CField("Control-plane URL (optional)", url, { url = it }, placeholder = "Auto-detected — leave blank", mono = true)
            store.baseUrl.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(6.dp))
                Text("Detected $it", color = Aurora.TextLow, fontSize = 11.sp, fontFamily = AppFonts.Mono)
            }
            Spacer(Modifier.height(10.dp))
            if (mode == "signup") {
                CField("Name", name, { name = it }, placeholder = "Your name")
                Spacer(Modifier.height(10.dp))
            }
            CField("Email", email, { email = it }, placeholder = "you@example.com")
            Spacer(Modifier.height(10.dp))
            CField("Password", password, { password = it }, placeholder = "••••••••", password = !showPassword)
            Spacer(Modifier.height(4.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Text(
                    if (showPassword) "Hide password" else "Show password",
                    color = Aurora.TextMid, fontSize = 11.sp,
                    modifier = Modifier.clickable { showPassword = !showPassword }.padding(4.dp),
                )
            }

            error?.let {
                Spacer(Modifier.height(8.dp))
                CNotice(it, Tone.BAD)
            }
            if (store.status == ConsoleStatus.ERROR) {
                Spacer(Modifier.height(8.dp))
                CNotice(store.error ?: "The control plane is unreachable.", Tone.BAD)
            }

            Spacer(Modifier.height(14.dp))
            CButton(
                text = if (pending) "Working…" else if (mode == "signup") "Create account" else "Sign in",
                onClick = { submit() },
                loading = pending,
                modifier = Modifier.fillMaxWidth(),
            )
            if (store.status == ConsoleStatus.ERROR) {
                Spacer(Modifier.height(8.dp))
                CButton(
                    "Auto-detect & retry",
                    onClick = {
                        scope.launch {
                            error = null
                            if (store.autoDetect() == null) error = ConsoleStore.NO_PLANE else store.refresh()
                        }
                    },
                    kind = BtnKind.GHOST,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        Spacer(Modifier.height(16.dp))
        Text("or", color = Aurora.TextLow, fontSize = 11.sp)
        Spacer(Modifier.height(10.dp))
        Column(Modifier.fillMaxWidth()) {
            Text(
                "Show a QR code on the dashboard's Device page, then scan it here to sign this phone in without typing a password.",
                color = Aurora.TextMid, fontSize = 12.sp,
            )
            Spacer(Modifier.height(10.dp))
            ScanToLinkButton(store, label = "Sign in with a QR code")
        }

        Spacer(Modifier.height(18.dp))
        Text("MobileCloud • Build. Ship. Scale.", color = Aurora.TextLow, fontSize = 11.sp)
    }
}
