package com.mobilecloud.terminal

import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructPollfd
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharsetDecoder
import java.nio.charset.CodingErrorAction
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Unix PTY master/slave spawner (master blueprint; terminal doc 1).
 *
 * Wraps the C++ forkpty bridge in libmobilecloud_native.so. The master fd is
 * drained on a dedicated `pty-io` thread that *parks in the kernel* via
 * [Os.poll] with an infinite timeout (audit finding P4.4) — there is no 20 ms
 * busy-poll, so an idle CloudShell costs no wake-ups. The poll set also watches
 * a private self-pipe so [close] can wake a parked reader at once instead of
 * waiting for the shell to exit. Decoded UTF-8 chunks are forwarded to the
 * active [TerminalSurfaceView]; keystrokes flow back through [write].
 */
class NativePtyController(
    private val engineBin: File,
    private val home: File,
    private val initialRows: Int = 24,
    private val initialCols: Int = 80,
) {
    /** Raw master fd owned by native code (released via [nativeClosePty]). */
    @Volatile private var masterFd: Int = -1

    /** Duplicate of [masterFd] used only for polling (owned by this class). */
    private var masterPollFd: ParcelFileDescriptor? = null

    /** Self-pipe: [wakeRead] is polled alongside the master, [wakeWrite] unblocks it. */
    private var wakeRead: ParcelFileDescriptor? = null
    private var wakeWrite: ParcelFileDescriptor? = null

    private val ioExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "pty-io") }
    private val mainHandler = Handler(Looper.getMainLooper())
    private val tornDown = AtomicBoolean(false)

    /**
     * Stateful UTF-8 decoder for the master stream, created once per PTY
     * session. A single `read(2)` can split a multi-byte character across two
     * read boundaries (e.g. a 3-byte `€` arriving as 1 byte then 2): decoding
     * each read independently with `String(buffer, 0, n, UTF_8)` turns such a
     * split character into replacement garbage. Feeding bytes through this one
     * decoder lets the trailing partial sequence be completed by the next read.
     */
    private val decoder: CharsetDecoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPLACE)
        .onUnmappableCharacter(CodingErrorAction.REPLACE)

    /** Bytes of an incomplete multi-byte character carried into the next read. */
    private val carry = ByteArrayOutputStream()

    /** Output listener receiving decoded UTF-8 text chunks. */
    var onOutput: ((String) -> Unit)? = null
    var onExit: (() -> Unit)? = null

    val isAlive: Boolean get() = masterFd >= 0

    fun start(shell: String = resolveShell()) {
        if (masterFd >= 0) return
        val path = "${engineBin.absolutePath}:/system/bin:/vendor/bin"
        val fd = nativeSpawnPty(
            initialRows, initialCols,
            shell, home.absolutePath, path,
        )
        if (fd < 0) {
            onExit?.invoke()
            return
        }
        masterFd = fd
        // A dup lets the reader poll the PTY without taking ownership of the
        // raw fd that nativeClosePty must release; the self-pipe lets close()
        // unblock a reader that is parked inside poll().
        masterPollFd = runCatching { ParcelFileDescriptor.fromFd(fd) }.getOrNull()
        runCatching { ParcelFileDescriptor.createPipe() }.getOrNull()?.let { pipe ->
            wakeRead = pipe[0]
            wakeWrite = pipe[1]
        }
        ioExecutor.execute(this::readLoop)
    }

    /**
     * Dedicated reader. [Os.poll] with a -1 timeout parks this thread in the
     * kernel until the PTY becomes readable, the slave hangs up, or [close]
     * writes to the self-pipe — nothing wakes it on a timer.
     */
    private fun readLoop() {
        val master = masterPollFd?.fileDescriptor
        val wake = wakeRead?.fileDescriptor
        val pollSet = ArrayList<StructPollfd>(2)
        if (master != null) {
            pollSet.add(StructPollfd().apply {
                fd = master
                events = OsConstants.POLLIN.toShort()
            })
        }
        if (wake != null) {
            pollSet.add(StructPollfd().apply {
                fd = wake
                events = OsConstants.POLLIN.toShort()
            })
        }
        val fds = pollSet.toTypedArray()
        val buffer = ByteArray(4096)
        try {
            while (masterFd >= 0 && master != null) {
                val ready: Int
                try {
                    ready = Os.poll(fds, /* timeoutMillis = */ -1)
                } catch (e: ErrnoException) {
                    if (e.errno == OsConstants.EINTR) continue else break
                }
                if (ready < 0) break

                // close() signalled teardown through the self-pipe.
                if (wake != null && (fds[1].revents.toInt() and OsConstants.POLLIN) != 0) break

                val masterEvents = fds[0].revents.toInt()
                if (masterEvents and OsConstants.POLLNVAL != 0) break // fd already closed
                if (masterEvents and
                    (OsConstants.POLLIN or OsConstants.POLLHUP or OsConstants.POLLERR) == 0
                ) {
                    continue
                }

                val n = nativeReadPty(masterFd, buffer, buffer.size)
                when {
                    n > 0 -> {
                        val chunk = decodeUtf8(buffer, n)
                        if (chunk.isNotEmpty()) mainHandler.post { onOutput?.invoke(chunk) }
                    }
                    // 0 is a benign EAGAIN race against poll readiness: park
                    // again on the next poll — no sleep, no busy loop.
                    n == 0 -> Unit
                    else -> break // error or EOF — slave closed
                }
            }
        } finally {
            // Flush the decoder so a trailing incomplete sequence surfaces as a
            // replacement character instead of being dropped silently at EOF.
            val tail = flushDecoder()
            if (tail.isNotEmpty()) mainHandler.post { onOutput?.invoke(tail) }
            teardown()
            mainHandler.post { onExit?.invoke() }
        }
    }

    /**
     * Incrementally decode one read. Any bytes left over from a partial
     * multi-byte sequence — whether held by the decoder or in [carry] — are
     * prepended to the next read, so a character split across reads is
     * reassembled rather than decoded as two broken pieces, and each byte is
     * delivered to the UI exactly once.
     */
    private fun decodeUtf8(bytes: ByteArray, length: Int): String {
        val pending = carry.toByteArray()
        carry.reset()
        val input = ByteBuffer.allocate(pending.size + length)
        input.put(pending)
        input.put(bytes, 0, length)
        input.flip()

        // A decoded char never needs more entries than the byte count for UTF-8
        // (a 4-byte sequence is at most a surrogate pair); the margin is slack.
        val chars = CharBuffer.allocate(input.remaining() + 8)
        chars.clear()
        decoder.decode(input, chars, /* endOfInput = */ false)
        chars.flip()

        if (input.hasRemaining()) {
            val leftover = ByteArray(input.remaining())
            input.get(leftover)
            carry.write(leftover)
        }
        return chars.toString()
    }

    /** Final decode at session end: completes any partial sequence and flushes. */
    private fun flushDecoder(): String {
        val pending = carry.toByteArray()
        carry.reset()
        val input = ByteBuffer.wrap(pending)
        val chars = CharBuffer.allocate(pending.size + 8)
        decoder.decode(input, chars, /* endOfInput = */ true)
        decoder.flush(chars)
        chars.flip()
        return chars.toString()
    }

    /** Keystrokes / control sequences into the PTY slave. */
    fun write(data: String) {
        val fd = masterFd
        if (fd < 0) return
        val bytes = data.toByteArray(Charsets.UTF_8)
        nativeWritePty(fd, bytes, bytes.size)
    }

    /** TIOCSWINSZ — dispatches SIGWINCH to the running program. */
    fun resize(rows: Int, cols: Int) {
        val fd = masterFd
        if (fd >= 0) nativeResizePty(fd, rows, cols)
    }

    /**
     * Close the session. Wakes a parked reader through the self-pipe so it runs
     * [teardown] on the reader thread; if no reader was ever parked the teardown
     * runs inline.
     */
    fun close() {
        if (masterFd < 0) return
        val w = wakeWrite
        if (w != null) {
            runCatching { Os.write(w.fileDescriptor, byteArrayOf(1), 0, 1) }
        } else {
            teardown()
        }
    }

    /** Idempotent teardown; runs on the reader thread (or inline if it never started). */
    private fun teardown() {
        if (!tornDown.compareAndSet(false, true)) return
        val fd = masterFd
        masterFd = -1
        runCatching { masterPollFd?.close() }
        masterPollFd = null
        runCatching { wakeRead?.close() }
        wakeRead = null
        runCatching { wakeWrite?.close() }
        wakeWrite = null
        if (fd >= 0) nativeClosePty(fd)
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
