package com.mobilecloud.ui.auth

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.mobilecloud.auth.AuthRequestNotifier
import com.mobilecloud.auth.LoginApprovalClient
import com.mobilecloud.auth.LoginApprovalRequest
import com.mobilecloud.console.CloudClient
import com.mobilecloud.console.ConsoleStore
import com.mobilecloud.ui.console.BtnKind
import com.mobilecloud.ui.console.CButton
import com.mobilecloud.ui.console.CHairline
import com.mobilecloud.ui.console.CNotice
import com.mobilecloud.ui.console.Tone
import com.mobilecloud.ui.theme.AppFonts
import com.mobilecloud.ui.theme.Aurora
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Confirms one "Login with MobileCloud" request before the browser is signed in.
 *
 * This screen is self-contained: it owns its pending, prompting, countdown and
 * error state and reports completion with [onApproved] / [onDenied], so a host
 * can show it as a route without wiring the console shell. The approval only
 * leaves the phone after BiometricPrompt confirms the account owner, because a
 * notification tap (or a shoulder-surfed code) is not proof by itself.
 *
 * [client] must be the signed-in console client for the server named in
 * [request]; [LoginApprovalRequest.matches] is checked before anything is sent.
 */
@Composable
fun LoginApprovalScreen(
    request: LoginApprovalRequest,
    onApproved: () -> Unit,
    onDenied: () -> Unit,
    activity: FragmentActivity,
    client: CloudClient,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pending by remember(request) { mutableStateOf(false) }
    var prompting by remember(request) { mutableStateOf(false) }
    var failure by remember(request) { mutableStateOf<String?>(null) }
    var now by remember(request) { mutableStateOf(System.currentTimeMillis()) }
    val sameServer = remember(request, client) { request.matches(client) }
    val remaining = (request.expiresAt - now).coerceAtLeast(0L)
    val expired = remaining <= 0L

    // The expiry is server wall-clock time, so tick against the wall clock.
    LaunchedEffect(request) {
        while (true) {
            now = System.currentTimeMillis()
            delay(500L)
        }
    }

    fun submitApproval() {
        if (pending) return
        pending = true
        failure = null
        scope.launch {
            try {
                // Best effort: the browser lights up "phone detected", but a
                // stale challenge marker must not block the approval itself.
                LoginApprovalClient.markScanned(client, request)
                LoginApprovalClient.approve(client, request, null)
                AuthRequestNotifier.cancel(context, request.challengeId)
                onApproved()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                failure = ConsoleStore.safeError(error, "This sign-in request could not be approved.")
            } finally {
                pending = false
            }
        }
    }

    fun submitDenial() {
        if (pending) return
        pending = true
        failure = null
        scope.launch {
            try {
                LoginApprovalClient.deny(client, request)
                AuthRequestNotifier.cancel(context, request.challengeId)
                onDenied()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                failure = ConsoleStore.safeError(error, "This sign-in request could not be denied.")
            } finally {
                pending = false
            }
        }
    }

    fun authenticateThenApprove() {
        if (pending || prompting) return
        if (!sameServer) {
            failure = "This request was started for a different server."
            return
        }
        if (expired) {
            failure = "This request has expired. Ask the browser to show a new code."
            return
        }
        failure = null
        // Device credential is the fallback when biometrics are not enrolled,
        // so the prompt must not also set a negative button (the platform
        // rejects that combination).
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        when (BiometricManager.from(context).canAuthenticate(authenticators)) {
            BiometricManager.BIOMETRIC_SUCCESS -> Unit
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> {
                failure = "Set a fingerprint, face unlock, or screen lock before approving."
                return
            }
            else -> {
                failure = "This device cannot confirm your identity right now."
                return
            }
        }
        prompting = true
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(context),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    prompting = false
                    submitApproval()
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    prompting = false
                    failure = errString.toString().ifBlank { "Authentication was cancelled." }
                }
            },
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Approve web sign-in")
            .setSubtitle("Verification code ${request.verificationCode}")
            .setDescription("Only approve if you started this sign-in in your own browser.")
            .setAllowedAuthenticators(authenticators)
            .build()
        runCatching { prompt.authenticate(info) }.onFailure {
            prompting = false
            failure = "The biometric prompt could not be shown. Try again."
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(Aurora.Bg)
            .verticalScroll(rememberScrollState())
            .padding(top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding())
            .padding(horizontal = 18.dp, vertical = 22.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Fingerprint, contentDescription = null, tint = Aurora.Cyan, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                "MOBILECLOUD AUTH",
                color = Aurora.TextLow,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 1.2.sp,
            )
        }
        Spacer(Modifier.height(14.dp))
        Text(
            "Web sign-in request",
            color = Aurora.TextHi,
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = (-0.4).sp,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            "A browser is asking to sign in to your MobileCloud account with this phone.",
            color = Aurora.TextMid,
            fontSize = 13.sp,
            lineHeight = 19.sp,
        )
        Spacer(Modifier.height(18.dp))

        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(Aurora.Card)
                .border(1.dp, Aurora.Border, RoundedCornerShape(12.dp))
                .padding(16.dp),
        ) {
            Text(
                "VERIFICATION CODE",
                color = Aurora.TextLow,
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.8.sp,
            )
            Spacer(Modifier.height(8.dp))
            Box(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(Aurora.CardWell)
                    .border(1.dp, Aurora.Border, RoundedCornerShape(8.dp))
                    .padding(vertical = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    request.verificationCode,
                    color = Aurora.Cyan,
                    fontSize = 30.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = AppFonts.Mono,
                    letterSpacing = 8.sp,
                )
            }
            Spacer(Modifier.height(6.dp))
            CHairline()
            DetailRow("Browser", request.browser.ifBlank { "Unknown browser" })
            CHairline()
            DetailRow("Server", request.serverOrigin, mono = true)
            CHairline()
            DetailRow(
                label = "Expires in",
                value = if (expired) "Expired" else remainingLabel(remaining),
                mono = true,
                valueColor = when {
                    expired -> Aurora.Red
                    remaining <= 30_000L -> Aurora.Amber
                    else -> Aurora.TextHi
                },
            )
        }

        Spacer(Modifier.height(14.dp))
        CNotice(
            "Only approve if you started this request. MobileCloud will never ask you to approve a sign-in you did not begin.",
            Tone.WARN,
        )
        if (!sameServer) {
            Spacer(Modifier.height(10.dp))
            CNotice(
                "This request is for ${request.serverOrigin}, but this phone is signed in to a different server. " +
                    "It cannot be approved here.",
                Tone.BAD,
            )
        }
        failure?.let {
            Spacer(Modifier.height(10.dp))
            CNotice(it, Tone.BAD)
        }

        Spacer(Modifier.height(18.dp))
        CButton(
            text = if (prompting) "Waiting for biometrics…" else "Approve with biometrics",
            onClick = { authenticateThenApprove() },
            loading = pending,
            enabled = !pending && !prompting && !expired && sameServer,
            icon = Icons.Filled.Fingerprint,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
        Text(
            "Uses your fingerprint, face unlock, or device PIN.",
            color = Aurora.TextLow,
            fontSize = 11.sp,
        )
        Spacer(Modifier.height(10.dp))
        CButton(
            text = "Deny",
            onClick = { submitDenial() },
            kind = BtnKind.GHOST,
            enabled = !pending && !prompting,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(18.dp))
        Text(
            "The browser is waiting for this response.",
            color = Aurora.TextFaint,
            fontSize = 11.sp,
        )
    }
}

/** Label over value, so a long browser description wraps instead of truncating. */
@Composable
private fun DetailRow(
    label: String,
    value: String,
    mono: Boolean = false,
    valueColor: Color = Aurora.TextHi,
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Text(
            label.uppercase(),
            color = Aurora.TextLow,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.6.sp,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            value,
            color = valueColor,
            fontSize = 13.sp,
            fontFamily = if (mono) AppFonts.Mono else AppFonts.Sans,
        )
    }
}

/** `m:ss`, rounded up so a fresh two-minute window reads `2:00`, not `1:59`. */
private fun remainingLabel(remainingMs: Long): String {
    val seconds = (remainingMs + 999L) / 1000L
    return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
}
