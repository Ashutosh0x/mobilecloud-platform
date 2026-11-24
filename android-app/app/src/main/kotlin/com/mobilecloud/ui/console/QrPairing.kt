package com.mobilecloud.ui.console

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import com.mobilecloud.console.ConsoleStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder

/**
 * QR pairing — the phone's half of "sign in by scanning the dashboard's code".
 *
 * The dashboard (a signed-in browser) creates a two-minute pairing session and
 * renders it as a QR code. This flow scans that code, registers the scan, waits
 * for the account owner to approve it on the dashboard, then claims the
 * approval. Claiming mints the durable device credential *and* sets the
 * `mc_session` cookie, so the phone ends up signed in without a password ever
 * being typed on it — and, because the realtime socket authenticates with that
 * same cookie, connected in real time.
 */

/** How long the phone waits for the dashboard to approve a scan. Matches the TTL. */
private const val PAIRING_WAIT_MS = 120_000L
private const val POLL_MS = 2_000L

/**
 * Payload carried by the dashboard's QR code:
 * `mobilecloud://pair?v=1&api=…&id=…&secret=…&code=…`.
 *
 * The validation mirrors `decodePairingTicket` in `lib/server/qr.ts` exactly, so
 * the only QR codes this app accepts are the ones the dashboard is willing to
 * produce: the right scheme and host, an `http(s)` origin, an id of at least 8
 * characters and a secret of at least 32 (the real secret is 256 bits encoded
 * as base64url).
 */
data class PairingTicket(val api: String, val id: String, val secret: String, val code: String) {
    companion object {
        private const val SCHEME = "mobilecloud"
        private const val HOST = "pair"
        private val ORIGIN = Regex("^https?://\\S+$")
        private val NON_ALNUM = Regex("[^A-Za-z0-9]")

        fun parse(payload: String): PairingTicket? {
            val uri = runCatching { URI(payload.trim()) }.getOrNull() ?: return null
            if (uri.scheme?.lowercase() != SCHEME || uri.host != HOST) return null
            val params = query(uri.rawQuery)
            val api = params["api"].orEmpty().trimEnd('/')
            val id = params["id"].orEmpty()
            val secret = params["secret"].orEmpty()
            val code = params["code"].orEmpty().replace(NON_ALNUM, "").uppercase()
            if (!ORIGIN.matches(api) || id.length < 8 || secret.length < 32) return null
            return PairingTicket(api, id, secret, code)
        }

        private fun query(raw: String?): Map<String, String> {
            if (raw.isNullOrEmpty()) return emptyMap()
            return raw.split('&').mapNotNull { pair ->
                val at = pair.indexOf('=')
                if (at < 0) return@mapNotNull null
                decode(pair.substring(0, at)) to decode(pair.substring(at + 1))
            }.toMap()
        }

        private fun decode(value: String): String =
            runCatching { URLDecoder.decode(value, "UTF-8") }.getOrDefault(value)
    }
}

/** Outcome of a pairing attempt. Transport errors are thrown, not modelled here. */
private sealed interface PairOutcome {
    data class Linked(val name: String) : PairOutcome
    data class Failed(val message: String) : PairOutcome
}

/**
 * Runs the phone's half of the handshake against the control plane named inside
 * the ticket: scan → wait for approval → claim.
 */
private suspend fun pairDevice(
    store: ConsoleStore,
    ticket: PairingTicket,
    onStatus: (String) -> Unit,
): PairOutcome {
    val payload = JSONObject()
        .put("name", deviceName())
        .put("platform", "android")
        .put("appVersion", BuildConfig.VERSION_NAME)
        .put("secret", ticket.secret)
    val secretOnly = jobj("secret" to ticket.secret).toString()

    // The QR carries the origin of the dashboard that produced it, so the phone
    // talks to that control plane rather than whatever it was pointed at before.
    store.applyBaseUrl(ticket.api)
    onStatus("Contacting ${ticket.api}…")
    store.client.request("device/pairing/${ticket.id}/scan", "POST", payload.toString())
    onStatus("Code scanned. Approve this device in the dashboard to finish.")

    val deadline = System.currentTimeMillis() + PAIRING_WAIT_MS
    while (System.currentTimeMillis() < deadline) {
        delay(POLL_MS)
        val status = store.client.request("device/pairing/${ticket.id}/status", "POST", secretOnly)
        when (status.optJSONObject("pairing")?.optString("status")) {
            "APPROVED" -> {
                val claim = store.client.request("device/pairing/${ticket.id}/claim", "POST", payload.toString())
                val name = claim.optJSONObject("device")?.optString("name").orEmpty()
                // The claim response set the session cookie, so this pulls the
                // account and opens the realtime socket.
                store.refresh()
                return PairOutcome.Linked(name.ifEmpty { deviceName() })
            }
            "EXPIRED" -> return PairOutcome.Failed("That code expired. Show a new one in the dashboard.")
            "REVOKED" -> return PairOutcome.Failed("The dashboard cancelled this pairing.")
            "FAILED" -> return PairOutcome.Failed("The dashboard could not complete the pairing.")
            else -> onStatus("Waiting for approval in the dashboard…")
        }
    }
    return PairOutcome.Failed("Timed out waiting for approval. Show a new code and try again.")
}

/** A human-readable name for this phone, e.g. "Google Pixel 7". */
private fun deviceName(): String {
    val maker = Build.MANUFACTURER.orEmpty().trim().replaceFirstChar { it.uppercase() }
    val model = Build.MODEL.orEmpty().trim()
    val modelCarriesMaker = maker.isNotEmpty() && model.startsWith(maker, ignoreCase = true)
    val parts = if (modelCarriesMaker || maker.isEmpty()) listOf(model) else listOf(maker, model)
    return parts.filter { it.isNotEmpty() }.joinToString(" ").ifEmpty { "Android device" }
}

/**
 * "Link this phone by QR code" control, shared by the login card and the
 * console's device page. Requests the camera permission, opens the scanner, and
 * then runs the pairing handshake, reporting progress inline.
 */
@Composable
fun ScanToLinkButton(
    store: ConsoleStore,
    modifier: Modifier = Modifier,
    label: String = "Scan QR code to link this phone",
    onLinked: () -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (contents.isNullOrBlank()) return@rememberLauncherForActivityResult
        val ticket = PairingTicket.parse(contents)
        if (ticket == null) {
            error = "That QR code is not a MobileCloud pairing code."
            return@rememberLauncherForActivityResult
        }
        error = null
        busy = true
        scope.launch {
            try {
                when (val outcome = pairDevice(store, ticket) { status = it }) {
                    is PairOutcome.Linked -> {
                        status = null
                        store.notify("Linked ${outcome.name}")
                        onLinked()
                    }
                    is PairOutcome.Failed -> {
                        status = null
                        error = outcome.message
                    }
                }
            } catch (e: Exception) {
                status = null
                error = e.message ?: "Pairing failed."
            } finally {
                busy = false
            }
        }
    }

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scanner.launch(scanOptions())
        else error = "Camera access is needed to scan the code."
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
