package com.mobilecloud.auth

import com.mobilecloud.console.CloudClient
import com.mobilecloud.console.CloudException
import com.mobilecloud.console.ConsoleOrigin
import kotlinx.coroutines.CancellationException
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder

/**
 * One "Login with MobileCloud" ticket, as shown by the browser in its QR code.
 *
 * [serverOrigin] is the canonical https origin the browser asked to sign in to.
 * It is kept as a string so the ticket can be posted to a notification and
 * read back without holding a live client.
 *
 * Version 1 tickets now carry `id=` (the 32-hex challenge row), and it wins.
 * A ticket minted by an older browser has no id, so [challenge] doubles as
 * [challengeId]; the console resolves either form to the same request.
 */
data class LoginApprovalRequest(
    val challengeId: String,
    val challenge: String,
    val verificationCode: String,
    val browser: String,
    val serverOrigin: String,
    val expiresAt: Long,
) {
    /**
     * True when this ticket was minted by the server the caller is connected
     * to. Approval is only meaningful against that origin: a ticket for a
     * different server cannot name the account whose session approves it.
     */
    fun matches(client: CloudClient): Boolean =
        serverOrigin.equals(client.origin.url, ignoreCase = true)

    companion object {
        /**
         * Parses a scanned or linked ticket, rejecting anything that is not
         * exactly one well-formed version 1 https login request.
         *
         * The parse is deliberately strict — an allow-list of parameters, one
         * occurrence each, canonical origin, fixed-length hex challenge, code
         * alphabet, and a still-future expiry — because this payload is
         * attacker-controlled: it decides which server is spoken to and which
         * challenge is approved.
         */
        fun parse(payload: String): LoginApprovalRequest? {
            if (payload.length !in 1..MAX_PAYLOAD) return null
            val uri = runCatching { URI(payload.trim()) }.getOrNull() ?: return null
            if (uri.scheme != SCHEME || uri.rawAuthority != HOST || uri.rawFragment != null) return null
            if (uri.rawPath.orEmpty() != "") return null
            val query = uri.rawQuery ?: return null
            val params = HashMap<String, String>()
            for (field in query.split('&')) {
                val at = field.indexOf('=')
                if (at <= 0) return null
                val key = field.substring(0, at)
                if (key !in PARAMS || params.containsKey(key)) return null
                val value = runCatching { URLDecoder.decode(field.substring(at + 1), "UTF-8") }
                    .getOrNull() ?: return null
                params[key] = value
            }
            if (!params.keys.containsAll(REQUIRED)) return null
            if (params["v"] != VERSION) return null
            val challenge = params["challenge"]?.takeIf(CHALLENGE::matches) ?: return null
            val code = params["code"]?.takeIf(CODE::matches) ?: return null
            val origin = params["api"]?.let(ConsoleOrigin::parse) ?: return null
            val browser = params["browser"].orEmpty()
            val expires = params["expires"]
                ?.takeIf { it.length in 1..MAX_EXPIRY_DIGITS && it.all(Char::isDigit) }
                ?.toLongOrNull() ?: return null
            val challengeId = if (params.containsKey("id")) {
                params["id"]?.takeIf(ID::matches) ?: return null
            } else {
                challenge
            }
            return fromParts(challengeId, challenge, code, browser, origin.url, expires, requireFuture = true)
        }

        /**
         * Rebuilds a ticket from its separate parts (the notification extras do
         * not preserve the id), applying the same structural checks.
         *
         * [requireFuture] is false for a notification tap: a request can expire
         * while its notification is still on screen, and the approver deserves
         * to see "expired" rather than a scan that silently does nothing.
         */
        internal fun fromParts(
            challengeId: String,
            challenge: String,
            verificationCode: String,
            browser: String,
            serverOrigin: String,
            expiresAt: Long,
            requireFuture: Boolean,
        ): LoginApprovalRequest? {
            if (!ID.matches(challengeId) || !CHALLENGE.matches(challenge)) return null
            if (!CODE.matches(verificationCode)) return null
            if (browser.length > MAX_BROWSER || browser.any { it.code in 0x00..0x1F || it.code in 0x7F..0x9F }) {
                return null
            }
            val origin = ConsoleOrigin.parse(serverOrigin) ?: return null
            if (expiresAt <= 0L) return null
            if (requireFuture && expiresAt <= System.currentTimeMillis()) return null
            return LoginApprovalRequest(
                challengeId = challengeId,
                challenge = challenge,
                verificationCode = verificationCode,
                browser = browser,
                serverOrigin = origin.url,
                expiresAt = expiresAt,
            )
        }
    }
}

/**
 * Talks to the browser's `qr-login` challenge.
 *
 * Every call is scoped to the client's own origin: approve and deny throw when
 * the ticket names a different server, and the best-effort scan is simply
 * ignored. Without that check a crafted ticket could ask the phone to act on
 * a challenge it does not belong to.
 */
object LoginApprovalClient {

    /** Tells the browser a phone is reviewing the request; failures are harmless. */
    suspend fun markScanned(client: CloudClient, request: LoginApprovalRequest) {
        if (!request.matches(client)) return
        try {
            client.request(endpoint(request, "scan"), "POST", deviceBody().toString())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // The browser only uses this to show "phone detected"; an expired
            // or already-handled challenge must not stop the real approval.
        }
    }

    /**
     * Approves the request with this phone's signed-in session.
     *
     * [assertion] optionally proves the account with a passkey instead of the
     * session cookie; the caller passes the WebAuthn assertion JSON when it has
     * one, or null to let the console use the session.
     */
    suspend fun approve(
        client: CloudClient,
        request: LoginApprovalRequest,
        assertion: JSONObject? = null,
    ) {
        requireOwnOrigin(client, request)
        val body = JSONObject()
            .put("challenge", request.challenge)
            .put("verification_code", request.verificationCode)
        if (assertion != null) body.put("credential", assertion)
        client.request(endpoint(request, "approve"), "POST", body.toString())
    }

    /** Refuses the request so the browser stops waiting on it. */
    suspend fun deny(client: CloudClient, request: LoginApprovalRequest) {
        requireOwnOrigin(client, request)
        client.request(endpoint(request, "deny"), "POST", JSONObject().toString())
    }

    private fun endpoint(request: LoginApprovalRequest, action: String): String =
        "auth/qr-login/${request.challengeId}/$action"

    private fun deviceBody(): JSONObject = JSONObject()
        .put("deviceName", androidDeviceName())
        .put("devicePlatform", ANDROID_PLATFORM)

    private fun requireOwnOrigin(client: CloudClient, request: LoginApprovalRequest) {
        if (!request.matches(client)) {
            throw CloudException("This sign-in request belongs to a different server.")
        }
    }
}

private const val SCHEME = "mobilecloud"
private const val HOST = "login"
private const val VERSION = "1"
private const val MAX_PAYLOAD = 2_048
private const val MAX_BROWSER = 180
private const val MAX_EXPIRY_DIGITS = 19

private val CHALLENGE = Regex("[0-9a-f]{64}")
private val CODE = Regex("[A-Z2-9]{6}")

// A row id is 32 hex characters; the challenge stand-in is 64. Both are
// path-safe for CloudClient's API path validator.
private val ID = Regex("[0-9a-f]{32}|[0-9a-f]{64}")

private val REQUIRED = setOf("v", "api", "challenge", "code", "browser", "expires")
private val PARAMS = REQUIRED + "id"
