package com.mobilecloud.terminal

import android.os.Handler
import android.os.Looper
import java.io.File
import java.util.concurrent.Executors

/**
 * Unix PTY master/slave spawner (master blueprint; terminal doc 1).
 *
 * Wraps the C++ forkpty bridge in libmobilecloud_native.so: the master fd
 * stays behind a polling loop that decodes UTF-8 and forwards bytes to the
 * active [TerminalSurfaceView]; keystrokes flow back through [write].
 */
class NativePtyController(
    private val engineBin: File,
    private val home: File,
    private val initialRows: Int = 24,
    private val initialCols: Int = 80,
) {
    private var masterFd: Int = -1
    private val ioExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "pty-io") }
    private val mainHandler = Handler(Looper.getMainLooper())

    /** Output listener receiving decoded UTF-8 text chunks. */
    var onOutput: ((String) -> Unit)? = null
    var onExit: (() -> Unit)? = null

    val isAlive: Boolean get() = masterFd >= 0

    fun start(shell: String = resolveShell()) {
        if (masterFd >= 0) return
        val path = "${engineBin.absolutePath}:/system/bin:/vendor/bin"
        masterFd = nativeSpawnPty(
            initialRows, initialCols,
            shell, home.absolutePath, path,
        )
        if (masterFd < 0) {
            onExit?.invoke()
            return
        }
        ioExecutor.execute(this::readLoop)
    }

    private fun readLoop() {
        val buffer = ByteArray(4096)
        while (masterFd >= 0) {
            val n = nativeReadPty(masterFd, buffer, buffer.size)
            when {
                n > 0 -> {
                    val chunk = String(buffer, 0, n, Charsets.UTF_8)
                    mainHandler.post { onOutput?.invoke(chunk) }
                }
                n == 0 -> Thread.sleep(20) // EAGAIN — poll cadence
                else -> { // error or EOF
                    close()
                    mainHandler.post { onExit?.invoke() }
                    return
                }
            }
        }
    }

    /** Keystrokes / control sequences into the PTY slave. */
    fun write(data: String) {
        if (masterFd < 0) return
        val bytes = data.toByteArray(Charsets.UTF_8)
        nativeWritePty(masterFd, bytes, bytes.size)
    }

    /** TIOCSWINSZ — dispatches SIGWINCH to the running program. */
    fun resize(rows: Int, cols: Int) {
        if (masterFd >= 0) nativeResizePty(masterFd, rows, cols)
    }

    fun close() {
        if (masterFd >= 0) {
            nativeClosePty(masterFd)
            masterFd = -1
        }
    }

    private fun resolveShell(): String =
        listOf("zsh", "bash", "sh")
            .map { engineBin.resolve(it) }
            .firstOrNull { it.exists() }?.absolutePath
            ?: "/system/bin/sh"

    // --- native bridge (cpp/jni_bridge.cpp, libmobilecloud_native.so) ---
    private external fun nativeSpawnPty(
        rows: Int, cols: Int, shellPath: String, envHome: String, envPath: String,
    ): Int

    private external fun nativeReadPty(fd: Int, buffer: ByteArray, maxBytes: Int): Int
    private external fun nativeWritePty(fd: Int, buffer: ByteArray, length: Int): Int
    private external fun nativeResizePty(fd: Int, rows: Int, cols: Int): Int
    private external fun nativeClosePty(fd: Int)

    companion object {
        init {
            try {
                System.loadLibrary("mobilecloud_native")
            } catch (e: UnsatisfiedLinkError) {
                e.printStackTrace()
            }
        }
    }
}
