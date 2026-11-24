package com.mobilecloud.security

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/**
 * REAL hardware-security detection and a Soroban-aligned device identity
 * (audit P7.1).
 *
 * AndroidKeyStore has no Ed25519 provider, so the identity is deliberately
 * split in two:
 *
 *  * **Anchor** ([ANCHOR_ALIAS]) — an AES-256-GCM key generated inside
 *    AndroidKeyStore (StrongBox first, TEE fallback). This is the hardware
 *    master secret and the only key the platform can vouch for.
 *  * **Soroban identity** — an Ed25519 keypair, the algorithm Stellar/Soroban
 *    verifies. Its PKCS#8 private bytes are AES-GCM-wrapped by the anchor and
 *    persisted, so the raw signing seed is never written in the clear.
 *
 * [Result.securityLevel] is read back from the anchor's `KeyInfo` and reported
 * verbatim — never inferred from which generation branch happened to succeed —
 * so a device that silently downgrades to a software key is reported as
 * SOFTWARE, not TEE.
 */
object HardwareAttestation {

    /** Hardware master secret: AES-256-GCM key held inside AndroidKeyStore. */
    const val ANCHOR_ALIAS = "mobilecloud_node_anchor"

    /** ECDSA P-256 identity installed by earlier builds; superseded by P7.1. */
    private const val LEGACY_EC_ALIAS = "mobilecloud_node_identity"

    private const val PREFS = "mobilecloud_node_identity"
    private const val PREF_WRAPPED = "ed25519_pkcs8_wrapped"
    private const val PREF_IV = "ed25519_gcm_iv"
    private const val PREF_PUBLIC = "ed25519_x509_public"
    private const val GCM_TAG_BITS = 128

    @Volatile private var appContext: Context? = null

    // Session-only identity material used when [install] was never called
    // (unit tests, previews); production always binds the application context.
    @Volatile private var sessionWrapped: ByteArray? = null
    @Volatile private var sessionIv: ByteArray? = null
    @Volatile private var sessionPublic: ByteArray? = null

    data class Result(
        val securityLevel: String, // STRONGBOX / TEE (StrongBox unavailable) / SOFTWARE / ERROR
        val keyAlgorithm: String,
        val publicKeySha256: String, // hex digest of the certificate public key
        val detail: String,
    )

    /** Bind the application context once; call from `Application.onCreate`. */
    fun install(context: Context) {
        appContext = context.applicationContext
    }

    /** Create the identity key if absent; report the true security level. */
    fun ensureIdentityKey(): Result = tryLevel { provision(rotate = false) }

    /** Explicit rotation: delete + regenerate both the anchor and the seed. */
    fun rotateKey(): Result = tryLevel { provision(rotate = true) }

    /**
     * Ed25519 (Soroban) signature over a 32-byte attestation digest, or `null`
     * when the platform or a tampered keystore cannot produce one.
     */
    fun signSorobanDigest(digest: ByteArray): ByteArray? {
        return try {
            val ks = loadKeystore()
            val privateKey = identityFor(ks).privateKey ?: return null
            Signature.getInstance("Ed25519").run {
                initSign(privateKey)
                update(digest)
                sign()
            }
        } catch (e: Exception) {
            null
        }
    }

    private inline fun tryLevel(block: () -> Result): Result =
        try {
            block()
        } catch (e: KeyPermanentlyInvalidatedException) {
            Result("ERROR", "-", "", "key invalidated (new biometric enrolment?) — rotate required")
        } catch (e: Exception) {
            Result("ERROR", "-", "", "${e.javaClass.simpleName}: ${e.message}")
        }

    private fun loadKeystore(): KeyStore =
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private data class Identity(
        val privateKey: PrivateKey?,
        val publicKey: PublicKey?,
        val created: Boolean,
    )

    private fun provision(rotate: Boolean): Result {
        val ks = loadKeystore()
        if (rotate) {
            ks.deleteEntry(ANCHOR_ALIAS)
            clearStoredIdentity()
        }
        // Drop the superseded P-256 identity so nothing keeps reaching for an
        // algorithm the Soroban verifier rejects.
        ks.deleteEntry(LEGACY_EC_ALIAS)

        ensureAnchor(ks)
        val level = anchorSecurityLevel(ks)
        val identity = identityFor(ks)
        val publicKey = identity.publicKey
        return Result(
            securityLevel = level,
            keyAlgorithm = publicKey?.algorithm ?: "unavailable",
            publicKeySha256 = publicKey?.let { sha256Hex(it.encoded).take(32) + "…" } ?: "-",
            detail = detailFor(level, identity),
        )
    }

    private fun detailFor(level: String, identity: Identity): String {
        if (identity.publicKey == null) {
            return "no Ed25519 identity on this platform — Android 13 (API 33) or newer is " +
                "required for Soroban Ed25519 signing"
        }
        val anchor = when (level) {
            "STRONGBOX" -> "Ed25519 seed wrapped by a StrongBox AES key"
            "TEE" -> "Ed25519 seed wrapped by a TEE AES key"
            "HARDWARE_BACKED" -> "Ed25519 seed wrapped by a secure-hardware AES key (type unknown)"
            "SOFTWARE" -> "Ed25519 seed wrapped by a software keystore key"
            else -> "anchor security level unreadable — treat the key as untrusted"
        }
        val state = if (identity.created) "generated" else "loaded from the wrapped seed"
        return "$anchor; identity $state. Ed25519 signing runs in the app process."
    }

    // ---- Hardware anchor (AES-256-GCM inside AndroidKeyStore) ----------------

    private fun ensureAnchor(ks: KeyStore) {
        if (ks.containsAlias(ANCHOR_ALIAS)) return
        try {
            generateAnchor(strongBox = true)
        } catch (e: StrongBoxUnavailableException) {
            generateAnchor(strongBox = false)
        } catch (e: Exception) {
            // Some OEM keystores reject StrongBox with a generic provider error
            // instead of StrongBoxUnavailableException; retry on the TEE.
            generateAnchor(strongBox = false)
        }
    }

    private fun generateAnchor(strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(
            ANCHOR_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .apply {
                if (strongBox && Build.VERSION.SDK_INT >= 28) setIsStrongBoxBacked(true)
            }
            .build()
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .apply { init(spec) }
            .generateKey()
    }

    private fun anchorSecurityLevel(ks: KeyStore): String = try {
        val secret = (ks.getEntry(ANCHOR_ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
        val info = SecretKeyFactory.getInstance(secret.algorithm, "AndroidKeyStore")
            .getKeySpec(secret, KeyInfo::class.java) as KeyInfo
        when {
            Build.VERSION.SDK_INT >= 31 -> when (info.securityLevel) {
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> "STRONGBOX"
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "TEE"
                KeyProperties.SECURITY_LEVEL_SOFTWARE -> "SOFTWARE"
                else -> "UNKNOWN(${info.securityLevel})"
            }
            else -> {
                @Suppress("DEPRECATION")
                if (info.isInsideSecureHardware) "HARDWARE_BACKED" else "SOFTWARE"
            }
        }
    } catch (e: Exception) {
        "ERROR"
    }

    // ---- Soroban Ed25519 identity (wrapped by the anchor) -------------------

    private fun identityFor(ks: KeyStore): Identity {
        readStoredIdentity()?.let { stored ->
            val pkcs8 = unwrap(ks, stored.wrapped, stored.iv)
            if (pkcs8 != null) {
                try {
                    val privateKey = KeyFactory.getInstance("Ed25519")
                        .generatePrivate(PKCS8EncodedKeySpec(pkcs8))
                    val publicKey = KeyFactory.getInstance("Ed25519")
                        .generatePublic(X509EncodedKeySpec(stored.public))
                    return Identity(privateKey, publicKey, created = false)
                } catch (e: Exception) {
                    // Stored material unusable (platform upgrade, corrupt prefs):
                    // fall through and mint a fresh identity.
                }
            }
        }
        return try {
            val keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
            val (wrapped, iv) = wrap(ks, keyPair.private.encoded)
            writeStoredIdentity(wrapped, iv, keyPair.public.encoded)
            Identity(keyPair.private, keyPair.public, created = true)
        } catch (e: Exception) {
            // No Ed25519 provider (pre-Android-13) — report honestly instead of
            // substituting an algorithm Soroban cannot verify.
            Identity(null, null, created = false)
        }
    }

    private fun wrap(ks: KeyStore, plaintext: ByteArray): Pair<ByteArray, ByteArray> {
        val anchor = (ks.getEntry(ANCHOR_ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, anchor)
        return cipher.doFinal(plaintext) to cipher.iv
    }

    private fun unwrap(ks: KeyStore, ciphertext: ByteArray, iv: ByteArray): ByteArray? = try {
        val anchor = (ks.getEntry(ANCHOR_ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, anchor, GCMParameterSpec(GCM_TAG_BITS, iv))
        cipher.doFinal(ciphertext)
    } catch (e: Exception) {
        null
    }

    // ---- Persistence (wrapped seed never written in the clear) ---------------

    private data class StoredIdentity(val wrapped: ByteArray, val iv: ByteArray, val public: ByteArray)

    private fun readStoredIdentity(): StoredIdentity? {
        val context = appContext
        if (context == null) {
            val wrapped = sessionWrapped ?: return null
            val iv = sessionIv ?: return null
            val public = sessionPublic ?: return null
            return StoredIdentity(wrapped, iv, public)
        }
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val wrapped = prefs.getString(PREF_WRAPPED, null) ?: return null
        val iv = prefs.getString(PREF_IV, null) ?: return null
        val public = prefs.getString(PREF_PUBLIC, null) ?: return null
        return StoredIdentity(decode(wrapped), decode(iv), decode(public))
    }

    private fun writeStoredIdentity(wrapped: ByteArray, iv: ByteArray, public: ByteArray) {
        val context = appContext
        if (context == null) {
            sessionWrapped = wrapped
            sessionIv = iv
            sessionPublic = public
            return
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(PREF_WRAPPED, encode(wrapped))
            .putString(PREF_IV, encode(iv))
            .putString(PREF_PUBLIC, encode(public))
            .apply()
    }

    private fun clearStoredIdentity() {
        appContext?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.clear()?.apply()
        sessionWrapped = null
        sessionIv = null
        sessionPublic = null
    }

    private fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun decode(value: String): ByteArray = Base64.decode(value, Base64.NO_WRAP)

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02X".format(it) }
}
