package com.mobilecloud.auth

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.mobilecloud.ui.MainActivity

/**
 * Posts the high-importance "a browser wants to sign in" request.
 *
 * The notification is the way a phone that is not already showing the app
 * learns about a pending web sign-in, so it has to be time-limited and
 * unmissable: the server challenge lives for two minutes, therefore the
 * notification removes itself after the same window.
 */
object AuthRequestNotifier {

    /** Creates the channel once. Safe to call before posting or at app start. */
    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Time-limited requests to approve a browser sign-in from this phone."
        }
        manager.createNotificationChannel(channel)
    }

    /**
     * Shows the request. Re-posting the same challenge replaces its earlier
     * notification instead of stacking duplicates.
     *
     * On Android 13+ the caller must already hold POST_NOTIFICATIONS; without
     * it the post is skipped silently rather than throwing at an awkward time.
     */
    fun post(context: Context, request: LoginApprovalRequest) {
        ensureChannel(context)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
            if (!granted) return
        }
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        // CLEAR_TOP + SINGLE_TOP deliver the tap to a running MainActivity as
        // onNewIntent instead of stacking a second copy of the console.
        val open = PendingIntent.getActivity(
            context,
            notificationId(request.challengeId),
            Intent(context, MainActivity::class.java)
                .setAction(AuthRequestIntent.ACTION)
                .putExtra(AuthRequestIntent.EXTRA_CHALLENGE, request.challenge)
                .putExtra(AuthRequestIntent.EXTRA_CHALLENGE_CODE, request.verificationCode)
                .putExtra(AuthRequestIntent.EXTRA_BROWSER, request.browser)
                .putExtra(AuthRequestIntent.EXTRA_SERVER, request.serverOrigin)
                .putExtra(AuthRequestIntent.EXTRA_EXPIRES, request.expiresAt)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val browser = request.browser.ifBlank { "A browser" }
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("Approve web sign-in?")
            .setContentText("Code ${request.verificationCode} · $browser")
            .setStyle(
                NotificationCompat.BigTextStyle().bigText(
                    "Verification code ${request.verificationCode}\n" +
                        "Browser: $browser\n" +
                        "Server: ${request.serverOrigin}\n\n" +
                        "Approve from the app only if you started this sign-in.",
                ),
            )
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            // The code stays off the lock screen until the device is unlocked.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(open)
            .setTimeoutAfter(REQUEST_TIMEOUT_MS)
            .build()
        runCatching { manager.notify(notificationId(request.challengeId), notification) }
    }

    /** Removes the request after it was approved, denied, or superseded. */
    fun cancel(context: Context, challengeId: String) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.cancel(notificationId(challengeId))
    }

    private const val CHANNEL_ID = "mobilecloud_auth"
    private const val CHANNEL_NAME = "Sign-in requests"
    private const val REQUEST_TIMEOUT_MS = 120_000L

    /** A positive, stable id per challenge so a re-post replaces its own notification. */
    private fun notificationId(challengeId: String): Int = challengeId.hashCode() and 0x7FFFFFFF
}

/**
 * The contract between the notification (or any deep link) and MainActivity.
 *
 * MainActivity must check [read] in both `onCreate` and `onNewIntent`, and
 * route a non-null ticket to the approval screen; the ticket deliberately
 * carries no navigation side effects of its own. The extras are re-validated
 * because MainActivity is exported and the intent could arrive from outside
 * the app.
 */
object AuthRequestIntent {

    /** The action a PendingIntent or deep link uses to request approval routing. */
    const val ACTION = "com.mobilecloud.AUTH_APPROVAL"

    internal const val EXTRA_CHALLENGE = "challenge"
    internal const val EXTRA_CHALLENGE_CODE = "challenge_code"
    internal const val EXTRA_BROWSER = "browser"
    internal const val EXTRA_SERVER = "server"
    internal const val EXTRA_EXPIRES = "expires"

    /**
     * Reads a ticket from [intent], or null when the intent is not an approval
     * request of this app's shape.
     *
     * An expired ticket is still returned so the approval screen can say so;
     * malformed extras — wrong type, bad challenge, non-https server — are
     * rejected here.
     */
    fun read(intent: Intent): LoginApprovalRequest? {
        if (intent.action != ACTION) return null
        return runCatching {
            val challenge = intent.getStringExtra(EXTRA_CHALLENGE) ?: return@runCatching null
            val code = intent.getStringExtra(EXTRA_CHALLENGE_CODE) ?: return@runCatching null
            val browser = intent.getStringExtra(EXTRA_BROWSER).orEmpty()
            val server = intent.getStringExtra(EXTRA_SERVER) ?: return@runCatching null
            val expires = intent.getLongExtra(EXTRA_EXPIRES, 0L)
            LoginApprovalRequest.fromParts(
                challengeId = challenge,
                challenge = challenge,
                verificationCode = code,
                browser = browser,
                serverOrigin = server,
                expiresAt = expires,
                requireFuture = false,
            )
        }.getOrNull()
    }
}
