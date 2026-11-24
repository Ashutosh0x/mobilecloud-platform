package com.mobilecloud.ui.screens

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import com.mobilecloud.ui.theme.AppFonts
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.mobilecloud.ui.theme.*
import kotlinx.coroutines.delay

/**
 * Edge security gate (GitHub AppLockActivity pattern → CIDS lock surface).
 *
 * Outermost render condition of MainActivity: biometric / device-credential
 * prompt against the FragmentActivity host. The node holds trade authority
 * and PoR signer material, so the prompt is auto-fired on gate entry.
 */
@Composable
fun AppLockScreen(activity: FragmentActivity, onUnlocked: () -> Unit) {
    val context = LocalContext.current
    var failed by remember { mutableStateOf(false) }
    var failureReason by remember { mutableStateOf("") }

    fun authenticate() {
        val biometricManager = BiometricManager.from(context)
        val authenticators =
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        when (biometricManager.canAuthenticate(authenticators)) {
            BiometricManager.BIOMETRIC_SUCCESS -> {
                val prompt = BiometricPrompt(
                    activity,
                    ContextCompat.getMainExecutor(context),
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            onUnlocked()
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            failed = true
                            failureReason = errString.toString()
                        }
                    }
                )
                val info = BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Unlock MobileCloud Node")
                    .setSubtitle("Edge financial compute · trading · PoR attestation")
                    .setAllowedAuthenticators(authenticators)
                    .build()
                prompt.authenticate(info)
            }
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ->
                failed = true.also { failureReason = "No biometric or device credential enrolled" }
            else ->
                failed = true.also { failureReason = "No secure lock screen available on this device" }
        }
    }

    LaunchedEffect(Unit) {
        // Small settle delay so the surface is drawn before the system prompt.
        delay(250)
        authenticate()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BgDark)
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("EDGE SECURITY GATE", color = TextSecondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.5.sp)
        Spacer(modifier = Modifier.height(24.dp))
        Icon(Icons.Filled.Lock, contentDescription = "Node locked", tint = PrimaryCyan, modifier = Modifier.size(48.dp))
        Spacer(modifier = Modifier.height(16.dp))
        Text("NODE LOCKED", color = TextPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            "Biometric authorization is required before trading, PoR attestation and CloudShell access.",
            color = TextSecondary, fontSize = 13.sp, lineHeight = 18.sp,
            modifier = Modifier.padding(horizontal = 16.dp),
        )
        Spacer(modifier = Modifier.height(32.dp))
        if (failed) {
            Text(failureReason, color = WarningAmber, fontSize = 12.sp)
            Spacer(modifier = Modifier.height(12.dp))
            Button(
                onClick = { authenticate() },
                colors = ButtonDefaults.buttonColors(containerColor = PrimaryCyan, contentColor = Background),
            ) {
                Text("RETRY AUTHENTICATION", fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
        } else {
            Text("Awaiting hardware TEE prompt…", color = TextSecondary, fontSize = 12.sp, fontFamily = AppFonts.Mono)
        }
        Spacer(modifier = Modifier.height(48.dp))
        Text(
            "StrongBox-backed · zero-transfer to host apps",
            color = AccentIndigo, fontSize = 11.sp, fontFamily = AppFonts.Mono,
        )
    }
}
