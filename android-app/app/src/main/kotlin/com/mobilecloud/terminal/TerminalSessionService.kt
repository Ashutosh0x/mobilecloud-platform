package com.mobilecloud.terminal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.mobilecloud.ui.MainActivity

/**
 * Keeps the on-device terminal alive while the app is in the background.
 *
 * Android suspends the application processor in Doze and reclaims background
 * processes under memory pressure. Either event kills the `tmux` client that
 * `NativePtyController` spawns; the `tmux` *server* survives, but only while
 * the app UID is alive, so a long build can be interrupted halfway.
 *
 * This service is the Termux model: a foreground service pins the UID and a
 * partial wake lock keeps the CPU out of deep sleep while a session is
 * active. It deliberately does **not** own the PTY — the PTY belongs to the
 * screen that shows it. The service only guarantees that the process (and
 * therefore the `tmux` server) is not reclaimed, so returning to CloudShell
 * re-attaches to the running session instead of starting a new one.
 *
 * The wake lock is only held while the service is running, and the service
 * is only running while the user asked for it.
 */
class TerminalSessionService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        createChannel()
        acquireWakeLock()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE
        startForegroundCompat(buildNotification(title))
        // START_STICKY: if the process is reclaimed anyway, the session comes
        // back with the notification instead of silently disappearing.
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        isRunning = false
        releaseWakeLock()
        super.onDestroy()
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // `specialUse` is the honest type for a developer terminal: the
            // work is a user-started shell session, not a data sync.
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val power = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        wakeLock = power
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG)
            .apply {
                setReferenceCounted(false)
                // A bounded timeout is safer than an unbounded lock: if the
                // service is killed without onDestroy, the CPU still wakes up.
                acquire(MAX_WAKE_LOCK_MILLIS)
            }
    }

    private fun releaseWakeLock() {
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        wakeLock = null
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Terminal session",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shown while a CloudShell session is kept alive in the background."
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(title: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, TerminalSessionService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText("The session stays alive while the app is in the background.")
            .setSmallIcon(android.R.drawable.ic_menu_upload)
            .setContentIntent(open)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(0, "Stop session", stop)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "mobilecloud.terminal"
        private const val NOTIFICATION_ID = 0x7E11
        private const val WAKE_LOCK_TAG = "MobileCloud:TerminalSession"
        private const val DEFAULT_TITLE = "MobileCloud CloudShell"
        private const val MAX_WAKE_LOCK_MILLIS = 6 * 60 * 60 * 1000L

        const val ACTION_STOP = "com.mobilecloud.terminal.STOP"
        const val EXTRA_TITLE = "title"

        /** True while the service is running and holding the wake lock. */
        @Volatile
        var isRunning: Boolean = false
            private set

        /** Start keeping the terminal session alive. */
        fun start(context: Context, title: String = DEFAULT_TITLE) {
            val intent = Intent(context, TerminalSessionService::class.java)
                .putExtra(EXTRA_TITLE, title)
            runCatching { context.startForegroundService(intent) }
                .onFailure { it.printStackTrace() }
        }

        /** Stop keeping the session alive and release the wake lock. */
        fun stop(context: Context) {
            runCatching {
                context.stopService(Intent(context, TerminalSessionService::class.java))
            }.onFailure { it.printStackTrace() }
        }

        /** Toggle, returning the state the session is now in. */
        fun toggle(context: Context, title: String = DEFAULT_TITLE): Boolean {
            return if (isRunning) {
                stop(context)
                false
            } else {
                start(context, title)
                true
            }
        }
    }
}
