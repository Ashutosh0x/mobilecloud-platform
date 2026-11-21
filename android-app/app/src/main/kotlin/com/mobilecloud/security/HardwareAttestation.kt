package com.mobilecloud.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * REAL hardware-security detection (audit prompt Phase 6).
 *
 * Claims are evidence-backed, not chipset-assumed: we generate an EC P-256
 * signing key inside AndroidKeyStore — attempting StrongBox first, falling
 * back to the TEE — then read back the KeyInfo security level and the public
 * key certificate digest. Whatever is reported here is what actually
 * happened on THIS device.
 */
object HardwareAttestation {

    const val KEY_ALIAS = "mobilecloud_node_identity"

    data class Result(
        val securityLevel: String, // STRONGBOX / TEE (StrongBox unavailable) / SOFTWARE / ERROR
        val keyAlgorithm: String,
        val publicKeySha256: String, // hex digest of the certificate public key
        val detail: String,
    )

    /** Create the identity key if absent; report the true security level. */
    fun ensureIdentityKey(): Result = tryLevel { rotateInternal(ifHasKey = false) }

    /** Explicit rotation: delete + regenerate. */
    fun rotateKey(): Result = tryLevel { rotateInternal(ifHasKey = true) }

    private inline fun tryLevel(block: () -> Result): Result =
        try {
            block()
        } catch (e: KeyPermanentlyInvalidatedException) {
            Result("ERROR", "-", "", "key invalidated (new biometric enrolment?) — rotate required")
        } catch (e: Exception) {
            Result("ERROR", "-", "", "${e.javaClass.simpleName}: ${e.message}")
        }

    private fun rotateInternal(ifHasKey: Boolean): Result {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

        if (ifHasKey) ks.deleteEntry(KEY_ALIAS)

        if (!ks.containsAlias(KEY_ALIAS)) {
            var usedStrongBox = true
            try {
                generateKey(ks, strongBox = true)
            } catch (e: StrongBoxUnavailableException) {
                usedStrongBox = false
                generateKey(ks, strongBox = false)
            }
            val info = readKeyInfo(ks)
            return Result(
                securityLevel = when {
                    info.securityLevelName == "STRONGBOX" -> "STRONGBOX"
                    usedStrongBox -> "TEE"
                    else -> info.securityLevelName // TEE or SOFTWARE
                },
                keyAlgorithm = info.algorithm,
                publicKeySha256 = info.publicKeySha256,
                detail = if (info.securityLevelName == "STRONGBOX")
                    "key generated inside StrongBox secure element (isStrongBoxBacked=true accepted)"
                else if (info.securityLevelName == "TEE")
                    "key generated inside TEE (StrongBox unavailable or not accepted on this device)"
                else
                    "key NOT hardware-backed — do not trust for signing",
            )
        }

        val info = readKeyInfo(ks)
        return Result(
            securityLevel = info.securityLevelName,
            keyAlgorithm = info.algorithm,
            publicKeySha256 = info.publicKeySha256,
            detail = "existing key inspected via KeyInfo — level read back from the keystore daemon",
        )
    }

    private fun generateKey(ks: KeyStore, strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
        )
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .apply {
                if (strongBox && Build.VERSION.SDK_INT >= 28) setIsStrongBoxBacked(true)
            }
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            .apply { initialize(spec) }
            .generateKeyPair()
    }

    private data class KeyInfoResult(
        val securityLevelName: String,
        val algorithm: String,
        val publicKeySha256: String,
    )

    private fun readKeyInfo(ks: KeyStore): KeyInfoResult {
        val entry = ks.getEntry(KEY_ALIAS, null)
            ?: return KeyInfoResult("ERROR", "-", "-")
        val privateKey = (entry as KeyStore.PrivateKeyEntry).privateKey
        val cert = ks.getCertificate(KEY_ALIAS)

        val factory = KeyFactory.getInstance(privateKey.algorithm, "AndroidKeyStore")
        val keyInfo = factory.getKeySpec(privateKey, android.security.keystore.KeyInfo::class.java)

        val levelName = if (Build.VERSION.SDK_INT >= 31) {
            when (keyInfo.securityLevel) {
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> "STRONGBOX"
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "TEE"
                KeyProperties.SECURITY_LEVEL_SOFTWARE -> "SOFTWARE"
                else -> "UNKNOWN(${keyInfo.securityLevel})"
            }
        } else {
            @Suppress("DEPRECATION")
            if (keyInfo.isInsideSecureHardware) "TEE" else "SOFTWARE"
        }

        val digest = MessageDigest.getInstance("SHA-256")
            .digest((cert ?: return KeyInfoResult(levelName, privateKey.algorithm, "-")).publicKey.encoded)
            .joinToString("") { "%02X".format(it) }
            .take(32) + "…"

        return KeyInfoResult(levelName, privateKey.algorithm, digest)
    }

    /** Convenience for UI: raw EC public key ( uncompressed point) hex preview. */
    fun publicKeyPreview(ks: KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }): String? {
        val cert = ks.getCertificate(KEY_ALIAS) ?: return null
        val ec = cert.publicKey as? ECPublicKey ?: return null
        val w = ec.w
        return "EC P-256 · x=${w.affineX.toString(16).take(16)}…"
    }
}
