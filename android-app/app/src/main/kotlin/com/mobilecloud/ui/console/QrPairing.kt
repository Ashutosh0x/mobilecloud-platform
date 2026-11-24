package com.mobilecloud.ui.console

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.mobilecloud.BuildConfig
import com.mobilecloud.console.CloudException
import com.mobilecloud.console.ConsoleOrigin
import com.mobilecloud.console.ConsoleStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder

private const val PAIRING_WAIT_MS = 120_000L
private const val POLL_MS = 2_000L
private val ID = Regex("[0-9a-f]{32}")
private val SECRET = Regex("[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]") // 32 bytes, canonical unpadded base64url.
private val CODE = Regex("[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}")

/** Version 1 of the existing mobilecloud://pair ticket. Do not stringify the proof. */
internal class PairingTicket private constructor(val origin: ConsoleOrigin, val id: String, val secret: String, val code: String) {
    companion object {
        fun parse(payload: String): PairingTicket? {
            if (payload.length !in 1..2048) return null
            val uri = runCatching { URI(payload.trim()) }.getOrNull() ?: return null
            if (uri.scheme != "mobilecloud" || uri.rawAuthority != "pair" || uri.rawPath != "" || uri.rawFragment != null) return null
            val query = uri.rawQuery ?: return null
            val fields = query.split('&')
            if (fields.size != 5) return null
            val params = HashMap<String, String>()
            for (field in fields) {
                val at = field.indexOf('=')
                if (at <= 0) return null
                val key = field.substring(0, at)
                if (key !in setOf("v", "api", "id", "secret", "code") || params.containsKey(key)) return null
                val value = runCatching { URLDecoder.decode(field.substring(at + 1), "UTF-8") }.getOrNull() ?: return null
                params[key] = value
            }
            if (params["v"] != "1") return null
            val origin = ConsoleOrigin.parse(params.getValue("api"))?.takeUnless { it.isLocalOnly() } ?: return null
            val id = params.getValue("id").takeIf(ID::matches) ?: return null
            val secret = params.getValue("secret").takeIf(SECRET::matches) ?: return null
            val code = params.getValue("code").takeIf(CODE::matches) ?: return null
            return PairingTicket(origin, id, secret, code)
        }
    }

    fun verify(response: JSONObject): JSONObject {
        val pairing = response.optJSONObject("pairing")
        if (pairing == null || pairing.opt("pairing_id") != id || pairing.opt("verification_code") != code) {
            throw CloudException("The console did not verify this pairing code.")
        }
        return pairing
    }
}

/** No existing session or cookie is used in this flow. */
private suspend fun pairDevice(store: ConsoleStore, ticket: PairingTicket, onStatus: (String) -> Unit) {
    store.authenticate(ticket.origin) { candidate ->
        withTimeoutOrNull(PAIRING_WAIT_MS) {
            val payload = JSONObject().put("name", deviceName()).put("platform", "android")
                .put("appVersion", BuildConfig.VERSION_NAME).put("secret", ticket.secret).toString()
            val secretOnly = JSONObject().put("secret", ticket.secret).toString()
            val path = "device/pairing/${ticket.id}"
            onStatus("Checking the pairing code…")
            var pairing = ticket.verify(candidate.request("$path/scan", "POST", payload))
            var deadline = SystemClock.elapsedRealtime() + PAIRING_WAIT_MS
            var approval: Boolean
            do {
                val ttl = (pairing.opt("expires_in_ms") as? Number)?.toLong()
                    ?: throw CloudException("The console returned an invalid pairing status.")
                val now = SystemClock.elapsedRealtime()
                deadline = minOf(deadline, now + ttl.coerceIn(0L, PAIRING_WAIT_MS))
                approval = when (pairing.opt("status")) {
                    "APPROVED" -> true
                    "SCANNED", "AWAITING_APPROVAL" -> false
                    "EXPIRED" -> throw CloudException("That code expired. Show a new one in the dashboard.")
                    "REVOKED" -> throw CloudException("The dashboard cancelled this pairing.")
                    "CONNECTED" -> throw CloudException("This code was already used. Show a new one in the dashboard.")
                    else -> throw CloudException("The dashboard did not approve this pairing.")
                }
                if (now >= deadline) throw CloudException("That code expired. Show a new one in the dashboard.")
                if (!approval) {
                    onStatus("Compare ${ticket.code} in the dashboard and approve this phone there.")
                    delay(minOf(POLL_MS, deadline - now))
                    if (SystemClock.elapsedRealtime() >= deadline) throw CloudException("That code expired. Show a new one in the dashboard.")
                    pairing = ticket.verify(candidate.request("$path/status", "POST", secretOnly))
                }
            } while (!approval)
            onStatus("Verifying the new session…")
            val claim = candidate.request("$path/claim", "POST", payload)
            val connected = ticket.verify(claim)
            val deviceId = claim.optJSONObject("device")?.opt("id") as? String
            val accountId = claim.opt("account_id") as? String
            if (deviceId == null || !ID.matches(deviceId) || accountId == null || !ID.matches(accountId) ||
                connected.opt("status") != "CONNECTED" || connected.opt("connected_device_id") != deviceId
            ) throw CloudException("The console did not confirm the pairing claim.")
            // The device credential is deliberately not retained. Only the in-memory HTTP session is used.
            Unit to accountId
        } ?: throw CloudException("Timed out waiting for pairing. Check the dashboard before trying a new code.")
    }
}

private fun deviceName(): String {
    val maker = Build.MANUFACTURER.orEmpty().trim().replaceFirstChar { it.uppercase() }
    val model = Build.MODEL.orEmpty().trim()
    val parts = if (maker.isEmpty() || model.startsWith(maker, ignoreCase = true)) listOf(model) else listOf(maker, model)
    return parts.filter { it.isNotEmpty() }.joinToString(" ").ifEmpty { "Android device" }
}

/** Scans, confirms the destination and comparison code, then starts the pairing flow. */
@Composable
fun ScanToLinkButton(
    store: ConsoleStore,
    modifier: Modifier = Modifier,
    label: String = "Scan QR code to link this phone",
    onLinked: () -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var ticket by remember { mutableStateOf<PairingTicket?>(null) }
    var attempt by remember { mutableStateOf<Job?>(null) }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@rememberLauncherForActivityResult
        ticket = PairingTicket.parse(contents)
        error = if (ticket == null) "Use a valid MobileCloud QR code from a phone-reachable HTTPS console." else null
    }

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scanner.launch(scanOptions())
        else error = "Camera access is needed to scan the code."
    }

    ticket?.let { selected ->
        AlertDialog(
            onDismissRequest = { ticket = null },
            title = { Text("Confirm pairing") },
            text = {
                Text("Server: ${selected.origin.url}\n\nComparison code: ${selected.code}\n\nContinue only if both match the dashboard you opened.")
            },
            confirmButton = {
                TextButton(onClick = {
                    ticket = null
                    busy = true
                    attempt = scope.launch {
                        try {
                            pairDevice(store, selected) { status = it }
                            store.notify("Signed in on this phone")
                            onLinked()
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (failure: Exception) {
                            error = ConsoleStore.safeError(failure, "Pairing could not be verified. Check the dashboard before trying again.")
                        } finally {
                            status = null
                            busy = false
                        }
                    }
                }) { Text("Continue") }
            },
            dismissButton = { TextButton(onClick = { ticket = null }) { Text("Cancel") } },
        )
    }

    Column(modifier.fillMaxWidth()) {
        CButton(
            text = label,
            onClick = {
                error = null
                val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
                if (granted) scanner.launch(scanOptions()) else permission.launch(Manifest.permission.CAMERA)
            },
            kind = BtnKind.GHOST,
            loading = busy,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        )
        if (busy) CButton("Cancel pairing", onClick = { attempt?.cancel() }, kind = BtnKind.GHOST)
        status?.let {
            Spacer(Modifier.height(8.dp))
            Hint(it)
        }
        error?.let {
            Spacer(Modifier.height(8.dp))
            CNotice(it, Tone.BAD)
        }
    }
}

private fun scanOptions() = ScanOptions().apply {
    setDesiredBarcodeFormats(ScanOptions.QR_CODE)
    setPrompt("Scan the pairing code shown in the dashboard")
    setBeepEnabled(false)
    setOrientationLocked(false)
}
