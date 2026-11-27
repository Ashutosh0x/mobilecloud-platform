package com.mobilecloud.auth

import android.os.Build
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.fragment.app.FragmentActivity
import com.mobilecloud.console.CloudClient
import com.mobilecloud.console.CloudException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** The platform value every Android client reports to the control plane. */
internal const val ANDROID_PLATFORM = "android"

/**
 * A human-readable name for the account's device list.
 *
 * Only the public build fields are used — never ANDROID_ID, a serial, or any
 * other identifier — because the account owner sees this name on the web.
 */
internal fun androidDeviceName(): String {
    val maker = Build.MANUFACTURER.orEmpty().trim().replaceFirstChar { it.uppercase() }
    val model = Build.MODEL.orEmpty().trim()
    val parts = if (maker.isEmpty() || model.startsWith(maker, ignoreCase = true)) {
        listOf(model)
    } else {
        listOf(maker, model)
    }
    return parts.filter { it.isNotEmpty() }.joinToString(" ").ifEmpty { "Android device" }
}

/**
 * Creates and uses passkeys for the unified authentication system.
 *
 * A ceremony is split across two worlds: the challenge and the signed
 * credential go over HTTPS through [CloudClient], while the credential itself
 * is created by Credential Manager, which launches system UI and must be
 * called from the main thread with an Activity context. The two halves are
 * dispatched explicitly instead of trusting the caller's dispatcher.
 *
 * Nothing in this file logs. A challenge, a credential, an email, or a
 * password must never reach logcat or a crash report.
 */
object PasskeyManager {

    /** The outcome of one ceremony. [Error] is terminal for this attempt. */
    sealed interface Result {
        /** The console accepted the ceremony and set a session in [CloudClient]'s jar. */
        data class Success(val userId: String, val displayName: String, val deviceId: String) : Result

        /** The user dismissed the Credential Manager UI; nothing was sent. */
        data object Cancelled : Result

        /** No passkey is available for this account on this device. */
        data object NoCredential : Result

        /** A user-facing explanation; never retried automatically. */
        data class Error(val message: String) : Result
    }

    /**
     * Adds a passkey to the signed-in account, or proves the account once with
     * [email] and [password] when there is no session yet.
     *
     * A passkey never bootstraps an account on its own, so exactly one mode is
     * valid: no credentials at all (an [CloudClient] that already has a
     * session), or both credentials (bootstrap). Mixed input is rejected here
     * instead of spending a network round trip on it.
     */
    suspend fun register(
        activity: FragmentActivity,
        client: CloudClient,
        email: String? = null,
        password: String? = null,
    ): Result {
        val accountEmail = email?.trim()?.takeIf { it.isNotEmpty() }
        val accountPassword = password?.takeIf { it.isNotEmpty() }
        if ((accountEmail == null) != (accountPassword == null)) {
            return Result.Error("Enter both the email and the password to add a passkey.")
        }
        return try {
            val begin = withContext(Dispatchers.IO) {
                val body = JSONObject()
                    .put("deviceName", androidDeviceName())
                    .put("devicePlatform", ANDROID_PLATFORM)
                if (accountEmail != null && accountPassword != null) {
                    body.put("email", accountEmail).put("password", accountPassword)
                }
                client.request("auth/passkey/register/begin", "POST", body.toString())
            }
            val challengeId = begin.requireChallengeId()
            val options = begin.optJSONObject("publicKey") ?: throw CloudException(INVALID_REPLY)
            val credential = createCredential(activity, options.toString())
            val finish = withContext(Dispatchers.IO) {
                val body = JSONObject()
                    .put("challengeId", challengeId)
                    .put("credential", JSONObject(credential))
                    .put("deviceName", androidDeviceName())
                    .put("devicePlatform", ANDROID_PLATFORM)
                client.request("auth/passkey/register/finish", "POST", body.toString())
            }
            finish.sessionResult()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: CreateCredentialCancellationException) {
            Result.Cancelled
        } catch (_: GetCredentialCancellationException) {
            Result.Cancelled
        } catch (_: NoCredentialException) {
            Result.NoCredential
        } catch (_: CreateCredentialException) {
            Result.Error("The passkey could not be created on this device.")
        } catch (_: GetCredentialException) {
            Result.Error("The passkey could not be used on this device.")
        } catch (failure: CloudException) {
            Result.Error(failure.message ?: INVALID_REPLY)
        } catch (_: IllegalArgumentException) {
            // Credential Manager rejects creation options it cannot parse,
            // such as a request without a user name.
            Result.Error("The console sent a passkey request this device cannot use.")
        } catch (_: Exception) {
            Result.Error("The passkey request could not be completed. Try again.")
        }
    }

    /**
     * Signs in with a passkey.
     *
     * With no [email] the ceremony is discoverable: the authenticator offers
     * every passkey it holds for the relying party. With an email the console
     * narrows the request to that account's credentials.
     */
    suspend fun login(
        activity: FragmentActivity,
        client: CloudClient,
        email: String? = null,
    ): Result {
        val accountEmail = email?.trim()?.takeIf { it.isNotEmpty() }
        return try {
            val begin = withContext(Dispatchers.IO) {
                val body = JSONObject()
                    .put("deviceName", androidDeviceName())
                    .put("devicePlatform", ANDROID_PLATFORM)
                if (accountEmail != null) body.put("email", accountEmail)
                client.request("auth/passkey/login/begin", "POST", body.toString())
            }
            val challengeId = begin.requireChallengeId()
            val options = begin.optJSONObject("publicKey") ?: throw CloudException(INVALID_REPLY)
            val assertion = assertCredential(activity, options.toString())
            val finish = withContext(Dispatchers.IO) {
                val body = JSONObject()
                    .put("challengeId", challengeId)
                    .put("credential", JSONObject(assertion))
                    .put("deviceName", androidDeviceName())
                    .put("devicePlatform", ANDROID_PLATFORM)
                client.request("auth/passkey/login/finish", "POST", body.toString())
            }
            finish.sessionResult()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: CreateCredentialCancellationException) {
            Result.Cancelled
        } catch (_: GetCredentialCancellationException) {
            Result.Cancelled
        } catch (_: NoCredentialException) {
            Result.NoCredential
        } catch (_: CreateCredentialException) {
            Result.Error("The passkey could not be created on this device.")
        } catch (_: GetCredentialException) {
            Result.Error("The passkey could not be used on this device.")
        } catch (failure: CloudException) {
            Result.Error(failure.message ?: INVALID_REPLY)
        } catch (_: IllegalArgumentException) {
            Result.Error("The console sent a passkey request this device cannot use.")
        } catch (_: Exception) {
            Result.Error("The passkey request could not be completed. Try again.")
        }
    }

    /**
     * Runs the creation ceremony on the main thread. Credential Manager takes
     * the Activity so the provider UI joins this task; the returned JSON is
     * the standard WebAuthn registration response the console verifies.
     */
    private suspend fun createCredential(activity: FragmentActivity, requestJson: String): String =
        withContext(Dispatchers.Main.immediate) {
            val manager = CredentialManager.create(activity)
            val response = manager.createCredential(
                activity,
                CreatePublicKeyCredentialRequest(requestJson),
            )
            (response as? CreatePublicKeyCredentialResponse)?.registrationResponseJson
                ?: throw CloudException(INVALID_REPLY)
        }

    /** Runs the assertion ceremony on the main thread and returns its WebAuthn JSON. */
    private suspend fun assertCredential(activity: FragmentActivity, requestJson: String): String =
        withContext(Dispatchers.Main.immediate) {
            val request = GetCredentialRequest.Builder()
                .addCredentialOption(GetPublicKeyCredentialOption(requestJson))
                .build()
            val manager = CredentialManager.create(activity)
            val response = manager.getCredential(activity, request)
            (response.credential as? PublicKeyCredential)?.authenticationResponseJson
                ?: throw CloudException(INVALID_REPLY)
        }

    /** A challenge id is the only handle the finish call has; never send a blank one. */
    private fun JSONObject.requireChallengeId(): String =
        (opt("challenge_id") as? String)
            ?.takeIf { it.isNotBlank() && it.length <= MAX_CHALLENGE_ID }
            ?: throw CloudException("The console returned an invalid passkey challenge.")

    /**
     * The session envelope shared by both finish endpoints: `user` plus the
     * device the console just linked. A missing account id means the session
     * cannot be attributed, so it is treated as a protocol error.
     */
    private fun JSONObject.sessionResult(): Result {
        val account = optJSONObject("user") ?: throw CloudException(INVALID_REPLY)
        val userId = (account.opt("id") as? String)?.takeIf { it.isNotBlank() }
            ?: throw CloudException(INVALID_REPLY)
        val displayName = (account.opt("name") as? String)?.takeIf { it.isNotBlank() }
            ?: (account.opt("email") as? String)?.takeIf { it.isNotBlank() }
            ?: "MobileCloud account"
        val deviceId = (opt("device_id") as? String)?.takeIf { it.isNotBlank() }
            ?: throw CloudException(INVALID_REPLY)
        return Result.Success(userId, displayName, deviceId)
    }

    private const val INVALID_REPLY = "The console returned an invalid response."
    private const val MAX_CHALLENGE_ID = 128
}
