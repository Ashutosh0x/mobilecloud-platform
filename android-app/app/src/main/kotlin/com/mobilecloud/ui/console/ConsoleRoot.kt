package com.mobilecloud.ui.console

import android.content.SharedPreferences
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.mobilecloud.console.ConsoleOrigin
import com.mobilecloud.console.ConsoleStatus
import com.mobilecloud.console.ConsoleStore
import com.mobilecloud.ui.theme.Aurora
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Web-parity console entry point. Renders the login card until a session
 * exists, then the [ConsoleShell]. Mirrors `app/login/page.tsx` +
 * `components/Shell.tsx` combined into one mobile flow.
 */
@Composable
fun ConsoleRoot(prefs: SharedPreferences? = null) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current.applicationContext
    val store = remember(prefs, context) { ConsoleStore(scope, prefs, context) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(store, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> store.start()
                Lifecycle.Event.ON_STOP -> store.pause()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            store.pause()
        }
    }
    DisposableEffect(store) { onDispose { store.stop() } }

    when {
        store.status == ConsoleStatus.LOADING -> LoadingSplash()
        store.snapshot == null -> ConsoleLogin(store)
        else -> key(store.client) { ConsoleShell(store) }
    }
}

@Composable
fun ConsoleLogin(store: ConsoleStore) {
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(store.baseUrl) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf(false) }
    var confirmation by remember { mutableStateOf<ConsoleOrigin?>(null) }

    fun submit(origin: ConsoleOrigin) {
        if (pending) return
        val submittedEmail = email
        val submittedPassword = password
        pending = true
        error = null
        scope.launch {
            try {
                store.login(origin, submittedEmail, submittedPassword)
                password = ""
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                error = ConsoleStore.safeError(failure, "Sign-in could not be verified. Check the server and try again.")
            } finally {
                pending = false
            }
        }
    }

    confirmation?.let { origin ->
        AlertDialog(
            onDismissRequest = { confirmation = null },
            title = { Text("Confirm sign-in server") },
            text = { Text("Only continue if you intend to send your credentials to ${origin.url}.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmation = null
                    submit(origin)
                }) { Text("Continue") }
            },
            dismissButton = { TextButton(onClick = { confirmation = null }) { Text("Cancel") } },
        )
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
        LogoMark(48.dp)
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
                "Sign in with an account provisioned by your MobileCloud operator.",
                color = Aurora.TextMid, fontSize = 12.sp,
            )
            Spacer(Modifier.height(14.dp))
            CField("Console HTTPS address", url, { url = it }, placeholder = "https://console.example.com", mono = true)
            Spacer(Modifier.height(10.dp))
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

            (error ?: store.error)?.let {
                Spacer(Modifier.height(8.dp))
                CNotice(it, Tone.BAD)
            }

            Spacer(Modifier.height(14.dp))
            CButton(
                text = if (pending) "Signing in…" else "Sign in",
                onClick = {
                    val origin = ConsoleOrigin.parse(url)
                    error = if (origin == null) ConsoleStore.NO_PLANE else null
                    confirmation = origin
                },
                loading = pending,
                enabled = !pending,
                modifier = Modifier.fillMaxWidth(),
            )
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
