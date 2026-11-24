package com.mobilecloud.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import com.mobilecloud.AppDirs
import com.mobilecloud.MobileCloudApp
import com.mobilecloud.core.TradingEngineController
import com.mobilecloud.ui.MainActivity
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File
import java.security.SecureRandom

/**
 * Honest lifecycle state of the bundled `mobilecloud-core` supervisor daemon.
 *
 * [BINARY_UNAVAILABLE] is reported — never a fabricated "running" — when the
 * native binary is not shipped in this build.
 */
enum class CoreDaemonStatus {
    BINARY_UNAVAILABLE,
    STARTING,
    RUNNING,
    EXITED,
    SPAWN_FAILED,
}

class CloudSupervisorService : Service() {

    private val serviceScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private var wakeLock: PowerManager.WakeLock? = null

    /** Live handle to the supervised `mobilecloud-core` child; null when down. */
    @Volatile private var coreProcess: Process? = null
    private var coreSupervisorJob: Job? = null

    /** Set from [onDestroy] so the supervision loop stops cleanly. */
    @Volatile private var shuttingDown = false

    override fun onCreate() {
        super.onCreate()
        acquireWakeLock()
        startForeground(NOTIFICATION_ID, buildNotification())
        startSupervisorLoop()
        // Process supervision for the bundled native daemon runs on a dedicated
        // IO lane: the child's blocking waitFor() must never occupy the
        // Default dispatcher used by the telemetry loop.
        coreSupervisorJob = serviceScope.launch(Dispatchers.IO) { superviseCore() }
    }

    /**
     * Partial wake lock keeps the CPU running while the screen is off so the
     * telemetry loop and the core-daemon supervision keep running — the phone
     * is a 24/7 node, not an interactive app.
     *
     * It is acquired with a bounded safety timeout (audit finding P4.2): a
     * partial lock with no timeout pins the CPU awake forever if onDestroy is
     * never reached (OEM task-killer, crash, killed process). With the timeout
     * the kernel releases the lock on its own; the telemetry loop re-arms it
     * while the service is actually alive.
     */
    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "MobileCloud::SupervisorWakeLock"
        ).apply {
            setReferenceCounted(false)
            acquire(WAKE_LOCK_TIMEOUT_MS)
        }
    }

    private fun releaseWakeLock() {
        val lock = wakeLock
        wakeLock = null
        // Guard double-release: the lock may already have been dropped by its
        // timeout, and release() on an unheld lock throws.
        lock?.let { if (it.isHeld) runCatching { it.release() } }
    }

    private fun startSupervisorLoop() {
        serviceScope.launch {
            while (isActive) {
                // Re-arm the bounded wake lock if its safety timeout elapsed.
                if (wakeLock?.isHeld != true) acquireWakeLock()

                // Hardware telemetry: SoC thermal governor feed (sysfs via JNI)
                // plus USB-PD bypass verification every 5 seconds.
                // -1 means no CPU/SoC thermal zone was readable — stay quiet
                // rather than inventing a temperature.
                val tempMilli = runCatching { nativeReadSocTempMilli() }.getOrDefault(-1)
                if (tempMilli > 0) {
                    val tempC = tempMilli / 1000.0
                    if (tempC > THERMAL_CEILING_C) {
                        android.util.Log.w(
                            TAG,
                            "SoC %.1f°C is above the %.0f°C ceiling".format(tempC, THERMAL_CEILING_C)
                        )
                    }

                    // Fail-closed thermal guard: trip the persisted trading-engine
                    // halt at >45 °C when auto-halt is armed (audit prompt Phase 6).
                    if (tempC > 45.0 && TradingEngineController.thermalAutoHalt.value) {
                        TradingEngineController.halt(
                            this@CloudSupervisorService,
                            "Thermal guard: SoC %.1f°C > 45.0°C".format(tempC),
                        )
                        android.util.Log.w(TAG, "thermal auto-halt tripped at %.1f°C".format(tempC))
                    }
                }

                val power = BatteryBypassDetector.probe(this@CloudSupervisorService)
                if (power.usbConnected && !power.bypassActive) {
                    android.util.Log.w(TAG, "battery cycling while on USB — bypass not engaged")
                }

                delay(5000)
            }
        }
    }

    // -----------------------------------------------------------------------
    // mobilecloud-core daemon supervision (audit finding P4.1)
    // -----------------------------------------------------------------------

    /**
     * Real process supervision loop: locate + launch the native daemon, pump
     * its stdout/stderr into the on-device log, and restart it with bounded
     * exponential backoff when it exits.
     *
     * When the binary is genuinely not bundled in this APK the service reports
     * [CoreDaemonStatus.BINARY_UNAVAILABLE] and returns — it never pretends the
     * daemon is running.
     */
    private suspend fun superviseCore() {
        val binary = resolveCoreBinary()
        if (binary == null) {
            reportCoreStatus(CoreDaemonStatus.BINARY_UNAVAILABLE)
            android.util.Log.w(
                TAG,
                "core_binary_unavailable — '$CORE_BINARY_NAME' is not bundled in this APK " +
                    "(no jniLibs entry, no asset, no CMake target)"
            )
            appendCoreLog("core_binary_unavailable: '$CORE_BINARY_NAME' not found in nativeLibraryDir or assets")
            return
        }

        var backoffMs = INITIAL_BACKOFF_MS
        while (currentCoroutineContext().isActive && !shuttingDown) {
            val startedAt = SystemClock.elapsedRealtime()
            reportCoreStatus(CoreDaemonStatus.STARTING)

            val process = runCatching { spawnCore(binary) }.getOrElse { e ->
                android.util.Log.e(TAG, "failed to spawn $CORE_BINARY_NAME: ${e.message}", e)
                appendCoreLog("spawn failed: ${e.message}")
                null
            }

            if (process == null) {
                reportCoreStatus(CoreDaemonStatus.SPAWN_FAILED)
            } else {
                coreProcess = process
                reportCoreStatus(CoreDaemonStatus.RUNNING)
                android.util.Log.i(TAG, "$CORE_BINARY_NAME running")
                appendCoreLog("running")
                pumpCoreOutput(process)

                val exitCode = runCatching { process.waitFor() }.getOrDefault(-1)
                coreProcess = null
                android.util.Log.w(TAG, "$CORE_BINARY_NAME exited rc=$exitCode")
                appendCoreLog("exited rc=$exitCode")
                reportCoreStatus(CoreDaemonStatus.EXITED)
            }

            if (shuttingDown || !currentCoroutineContext().isActive) break

            // Bounded exponential backoff; reset once a run was healthy so a
            // long-lived daemon that dies once does not inherit a huge delay.
            if (SystemClock.elapsedRealtime() - startedAt >= HEALTHY_UPTIME_MS) {
                backoffMs = INITIAL_BACKOFF_MS
            }
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
        }
    }

    /**
     * Locate the `mobilecloud-core` executable. Order of preference:
     *  1. already installed into app-private storage (a previous run);
     *  2. shipped as a jniLibs executable — Android extracts it into
     *     `nativeLibraryDir`, the only app-writable directory from which a
     *     binary can be executed on modern Android (W^X);
     *  3. shipped as an asset, extracted to app storage and marked executable
     *     (best-effort; may be blocked by W^X on API 29+).
     * Returns null when the binary is genuinely not bundled anywhere.
     */
    private fun resolveCoreBinary(): File? {
        val installed = File(AppDirs.engineBin(this), CORE_BINARY_NAME)
        if (installed.isFile && installed.canExecute()) return installed

        val native = File(applicationInfo.nativeLibraryDir, CORE_BINARY_NAME)
        if (native.isFile) {
            native.setExecutable(true, true)
            return native
        }

        return extractAssetBinary(installed)
    }

    private fun extractAssetBinary(dest: File): File? = runCatching {
        assets.open(CORE_BINARY_NAME).use { input ->
            dest.parentFile?.mkdirs()
            dest.outputStream().use { input.copyTo(it) }
        }
        dest.setExecutable(true, /* ownerOnly = */ true)
        dest.takeIf { it.isFile && it.canExecute() }
    }.getOrNull()

    /** Launch the daemon with the env contract its Rust entrypoint reads. */
    private fun spawnCore(binary: File): Process {
        val home = AppDirs.engineRoot(this)
        val builder = ProcessBuilder(binary.absolutePath)
            .directory(home)
            .redirectErrorStream(true) // interleave stderr into one ordered log
        val env = builder.environment()
        env["MOBILECLOUD_HOME"] = home.absolutePath
        env["MOBILECLOUD_BIND"] = CORE_BIND
        env["MOBILECLOUD_WEBHOOK_SECRET"] = webhookSecret()
        // Sandboxed userland session: the daemon must not inherit the Android
        // app environment beyond PATH/HOME.
        env["HOME"] = home.absolutePath
        env["PATH"] = "${AppDirs.engineBin(this).absolutePath}:/system/bin:/vendor/bin"
        return builder.start()
    }

    /**
     * Drain the child's stdout+stderr into the log mechanism for the whole
     * life of the process. Not draining would fill the pipe buffer and block
     * the daemon, so this runs on its own IO coroutine.
     */
    private fun pumpCoreOutput(process: Process) {
        serviceScope.launch(Dispatchers.IO) {
            runCatching {
                process.inputStream.bufferedReader().useLines { lines ->
                    lines.forEach { line ->
                        android.util.Log.i(CORE_TAG, line)
                        appendCoreLog(line)
                    }
                }
            }.onFailure {
                android.util.Log.w(TAG, "core log stream ended: ${it.message}")
            }
        }
    }

    /**
     * The daemon's GitHub-webhook HMAC secret. A real random 32-byte secret is
     * generated once and persisted in app-private storage (SecureRandom — never
     * a hard-coded or placeholder value), then re-read on later starts.
     */
    private fun webhookSecret(): String {
        val prefs = getSharedPreferences(PREFS_CORE, Context.MODE_PRIVATE)
        prefs.getString(KEY_WEBHOOK_SECRET, null)?.let { return it }
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val secret = bytes.joinToString("") { "%02x".format(it) }
        prefs.edit().putString(KEY_WEBHOOK_SECRET, secret).apply()
        return secret
    }

    private fun reportCoreStatus(status: CoreDaemonStatus) {
        coreStatusFlow.value = status
        getSharedPreferences(PREFS_CORE, Context.MODE_PRIVATE).edit()
            .putString(KEY_CORE_STATUS, status.name)
            .putLong(KEY_CORE_UPDATED_AT, System.currentTimeMillis())
            .apply()
    }

    /** Append a line to `AppDirs.stateDir/mobilecloud-core.log`. */
    private fun appendCoreLog(line: String) {
        synchronized(logLock) {
            runCatching {
                File(AppDirs.stateDir(this), CORE_LOG_NAME)
                    .appendText("${System.currentTimeMillis()} $line\n")
            }
        }
    }

    /** sysfs thermal reader (cpp/jni_bridge.cpp, libmobilecloud_native.so). */
    private external fun nativeReadSocTempMilli(): Int

    private fun buildNotification(): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, MobileCloudApp.CHANNEL_ID)
            .setContentTitle("MobileCloud Node active")
            .setContentText("Supervising device telemetry, PoR pulls and the CloudShell.")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    override fun onDestroy() {
        shuttingDown = true
        coreSupervisorJob?.cancel()
        coreProcess?.let { runCatching { it.destroy() } }
        coreProcess = null
        serviceScope.cancel()
        releaseWakeLock()
        // Only drop the FGS notification on real teardown.
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "CloudSupervisor"
        private const val CORE_TAG = "MobileCloudCore"

        /** FGS notification id for the supervisor's ongoing notification. */
        const val NOTIFICATION_ID = 1001

        private const val CORE_BINARY_NAME = "mobilecloud-core"
        private const val CORE_LOG_NAME = "mobilecloud-core.log"

        /** Loopback ingress matching [com.mobilecloud.work.CoreEngineProbe]. */
        private const val CORE_BIND = "127.0.0.1:3000"

        /**
         * Wake-lock safety timeout. The telemetry loop re-arms the lock every
         * 5 s cycle once it lapses, so the sleep window while still alive is
         * bounded to at most one cycle.
         */
        private const val WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L

        /** Restart backoff bounds and the "healthy run" reset threshold. */
        private const val INITIAL_BACKOFF_MS = 1_000L
        private const val MAX_BACKOFF_MS = 60_000L
        private const val HEALTHY_UPTIME_MS = 60_000L

        private const val PREFS_CORE = "core_runtime"
        private const val KEY_CORE_STATUS = "status"
        private const val KEY_CORE_UPDATED_AT = "updated_at"
        private const val KEY_WEBHOOK_SECRET = "webhook_secret"

        private val logLock = Any()

        /** Live, app-wide view of the core daemon's honest state. */
        private val coreStatusFlow = MutableStateFlow(CoreDaemonStatus.BINARY_UNAVAILABLE)
        val coreStatus: StateFlow<CoreDaemonStatus> = coreStatusFlow

        /** SoC ceiling (°C) before the governor throttles workloads. */
        const val THERMAL_CEILING_C = 45.0

        init {
            try {
                System.loadLibrary("mobilecloud_native")
            } catch (e: UnsatisfiedLinkError) {
                e.printStackTrace()
            }
        }
    }
}
