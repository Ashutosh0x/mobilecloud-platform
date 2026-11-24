package com.mobilecloud.console

import android.content.SharedPreferences
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.CookieHandler
import java.net.CookieManager
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLSocketFactory
import kotlin.math.min
import kotlin.math.pow

/** Realtime connection states shown in the UI. Mirrors the web client. */
enum class RealtimeStatus { CONNECTING, CONNECTED, RECONNECTING, OFFLINE, SYNCING, SYNC_ERROR }

data class RealtimeState(
    val status: RealtimeStatus = RealtimeStatus.CONNECTING,
    val accountId: String? = null,
    val accountName: String? = null,
    val cursor: Long = 0,
    val lastSyncAt: Long? = null,
    val lastError: String? = null,
    val pending: Int = 0,
    val attempts: Int = 0,
    val via: String? = null,
) {
    val label: String
        get() = when (status) {
            RealtimeStatus.CONNECTED -> "Connected"
            RealtimeStatus.CONNECTING -> "Connecting"
            RealtimeStatus.RECONNECTING -> "Reconnecting"
            RealtimeStatus.OFFLINE -> "Offline"
            RealtimeStatus.SYNCING -> "Syncing"
            RealtimeStatus.SYNC_ERROR -> "Sync error"
        }
}

/** One durable change, in the shared envelope both clients understand. */
data class RealtimeEvent(
    val eventId: String,
    val eventType: String,
    val accountId: String,
    val resourceId: String?,
    val sequence: Long,
    val occurredAt: String,
    val payload: JSONObject,
)

/**
 * Production-quality realtime client.
 *
 * A persistent, authenticated WebSocket to the MobileCloud realtime gateway
 * (`/api/realtime`) that keeps this device's view of the account in step with
 * the server. It is deliberately dependency-free: the socket is spoken with
 * `java.net.Socket` and RFC 6455 framing so the app needs no extra library.
 *
 * Guarantees
 *  - one socket for the whole app (never per screen),
 *  - automatic reconnect with exponential backoff plus jitter,
 *  - heartbeat + dead-peer detection,
 *  - duplicate suppression by event id,
 *  - ordering by sequence with gap-triggered recovery,
 *  - durable cursor recovery through `GET /api/sync/changes` so a device that
 *    was offline for 30 minutes catches up instead of losing changes.
 *
 * Android does suspend background sockets; this client reconnects on resume,
 * on network change, and via [WorkManager][com.mobilecloud.work.WorkerScheduler]
 * for deferred catch-up.
 */
class RealtimeClient(
    private val scope: CoroutineScope,
    private val client: CloudClient,
    private val prefs: SharedPreferences? = null,
) {

    private val _state = MutableStateFlow(RealtimeState(cursor = readCursor()))
    val state: StateFlow<RealtimeState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<RealtimeEvent>(extraBufferCapacity = 128)
    val events = _events.asSharedFlow()

    private var job: Job? = null
    private var socket: Socket? = null
    private val recovering = AtomicBoolean(false)
    private val seen = LinkedHashSet<String>()
    private val random = SecureRandom()

    private var cursor: Long = readCursor()
        get() = field
        set(value) {
            field = value
            prefs?.edit()?.putLong(KEY_CURSOR, value)?.apply()
            _state.update { it.copy(cursor = value) }
        }

    // ------------------------------------------------------------- lifecycle ---

    /** Starts the connection; safe to call repeatedly while active. */
    fun start() {
        if (job?.isActive == true) return
        _state.update { it.copy(status = RealtimeStatus.CONNECTING) }
        job = scope.launch(Dispatchers.IO) { runLoop() }
    }

    /** Stops the connection and releases the socket. */
    fun stop() {
        job?.cancel()
        job = null
        closeSocket()
        _state.update { it.copy(status = RealtimeStatus.OFFLINE) }
    }

    /** Reconnects immediately (used by the diagnostics "Retry" action). */
    fun retry() {
        stop()
        start()
    }

    /** Drops identity + cursor — used on sign-out so the next account starts clean. */
    fun reset() {
        stop()
        seen.clear()
        cursor = 0
        prefs?.edit()?.remove(KEY_CURSOR)?.apply()
        _state.value = RealtimeState(status = RealtimeStatus.OFFLINE)
    }

    // ---------------------------------------------------------------- run loop ---

    private suspend fun runLoop() {
        var attempts = 0
        while (currentCoroutineContext().isActive) {
            var failure: String? = null
            try {
                pump()
                attempts = 0
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                failure = error.message ?: error.javaClass.simpleName
                Log.w(TAG, "realtime disconnected: $failure")
            } finally {
                closeSocket()
            }
            if (!currentCoroutineContext().isActive) return
            attempts += 1
            val wait = backoffMs(attempts)
            _state.update {
                it.copy(status = RealtimeStatus.RECONNECTING, attempts = attempts, lastError = failure)
            }
            delay(wait)
        }
    }

    /** Full jitter, bounded at 30s so a flapping network cannot hammer the server. */
    private fun backoffMs(attempts: Int): Long {
        val ceiling = min(MAX_BACKOFF_MS, (500.0 * 2.0.pow((attempts - 1).coerceAtMost(7))).toLong())
        val floor = ceiling / 2
        return floor + (random.nextDouble() * (ceiling - floor)).toLong()
    }

    /** Opens the socket and consumes frames until it dies. */
    private suspend fun pump() {
        val endpoint = resolveEndpoint() ?: throw CloudException("The realtime endpoint could not be resolved.")
        val cookie = sessionCookie()
        if (cookie == null) throw CloudException("Sign in required")

        val socket = openSocket(endpoint)
        this.socket = socket
        socket.soTimeout = DEAD_MS
        handshake(socket, endpoint, cookie)

        _state.update {
            it.copy(status = RealtimeStatus.SYNCING, attempts = 0, lastError = null)
        }

        // Ask for everything we missed while the device was offline.
        send(socket, JSONObject().put("type", "hello").put("cursor", cursor))

        val input = BufferedInputStream(socket.getInputStream())
        val heartbeat = scope.launch {
            while (isActive && !socket.isClosed) {
                delay(HEARTBEAT_MS)
                runCatching { send(socket, JSONObject().put("type", "ping")) }
            }
        }
        try {
            while (currentCoroutineContext().isActive && !socket.isClosed) {
                val frame = readFrame(input) ?: break
                when (frame.opcode) {
                    OP_PING -> writeFrame(socket.getOutputStream(), OP_PONG, frame.payload, mask = true)
                    OP_PONG -> Unit
                    OP_CLOSE -> return
                    OP_TEXT -> if (frame.fin) {
                        handleText(String(frame.payload, Charsets.UTF_8))
                    } else {
                        fragments.clear()
                        fragments.add(frame.payload)
                    }
                    OP_CONT -> {
                        fragments.add(frame.payload)
                        if (frame.fin) {
                            val text = String(joinFragments(), Charsets.UTF_8)
                            fragments.clear()
                            handleText(text)
                        }
                    }
                    OP_BINARY -> return
                    else -> Unit
                }
            }
        } catch (timeout: SocketTimeoutException) {
            throw CloudException("The realtime connection went silent.")
        } finally {
            heartbeat.cancel()
        }
    }

    private val fragments = ArrayDeque<ByteArray>()

    /** Reassembles a fragmented text message. */
    private fun joinFragments(): ByteArray {
        val out = ByteArrayOutputStream()
        for (chunk in fragments) out.write(chunk)
        return out.toByteArray()
    }

    // -------------------------------------------------------------- protocol ---

    private fun handleText(text: String) {
        val message = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (message.optString("type")) {
            "welcome" -> {
                _state.update {
                    it.copy(
                        status = RealtimeStatus.CONNECTED,
                        accountId = message.optString("account_id").ifBlank { it.accountId },
                        accountName = message.optString("account_name").ifBlank { null },
                        via = message.optString("via").ifBlank { null },
                        attempts = 0,
                        lastError = null,
                        lastSyncAt = System.currentTimeMillis(),
                    )
                }
                // Adopt the server cursor when we have none; otherwise the
                // `hello` replay already covered our backlog.
                val serverCursor = message.optLong("cursor", cursor)
                if (cursor == 0L) cursor = serverCursor
            }
            "event" -> message.optJSONObject("event")?.let { apply(it) }
            "replay_start" -> _state.update { it.copy(status = RealtimeStatus.SYNCING) }
            "replay_complete" -> {
                val latest = message.optLong("cursor", cursor)
                if (latest > cursor) cursor = latest
                _state.update { it.copy(status = RealtimeStatus.CONNECTED, lastSyncAt = System.currentTimeMillis(), pending = 0) }
            }
            "replay_incomplete" -> recover()
            "delivered" -> Unit
            "pong" -> Unit
            "ping" -> {
                socket?.let { s -> runCatching { send(s, JSONObject().put("type", "ping")) } }
            }
            "error" -> {
                val code = message.optString("code")
                if (code == "unauthorized" || code == "unauthenticated") {
                    _state.update { it.copy(status = RealtimeStatus.SYNC_ERROR, lastError = "The realtime session is not authorised.") }
                    stop()
                } else {
                    _state.update { it.copy(lastError = message.optString("message").ifBlank { "Realtime error" }) }
                }
            }
            else -> Unit
        }
    }

    /** Duplicate suppression, ordering, gap detection, fan-out. */
    private fun apply(json: JSONObject) {
        val event = RealtimeEvent(
            eventId = json.optString("event_id"),
            eventType = json.optString("event_type"),
            accountId = json.optString("account_id"),
            resourceId = json.optString("resource_id").takeIf { it.isNotBlank() && it != "null" },
            sequence = json.optLong("sequence"),
            occurredAt = json.optString("occurred_at"),
            payload = json.optJSONObject("payload") ?: JSONObject(),
        )
        if (event.eventId.isBlank() || seen.contains(event.eventId)) return
        seen.add(event.eventId)
        if (seen.size > SEEN_LIMIT) {
            // Drop the oldest ids so the dedupe set cannot grow without bound.
            val oldest = seen.iterator()
            val excess = seen.size - SEEN_LIMIT
            repeat(excess) { if (oldest.hasNext()) { oldest.next(); oldest.remove() } }
        }

        // A hole in the sequence means frames were lost — recover from the log.
        if (cursor > 0 && event.sequence > cursor + 1) recover()

        if (event.sequence > cursor) cursor = event.sequence
        _state.update { it.copy(pending = it.pending + 1, lastSyncAt = System.currentTimeMillis()) }

        _events.tryEmit(event)
        socket?.let { s -> runCatching { send(s, JSONObject().put("type", "ack").put("sequence", event.sequence)) } }
    }

    /**
     * Cursor-based catch-up through the REST API. Runs off the socket so a slow
     * recovery cannot stall live frames.
     */
    private fun recover() {
        if (!recovering.compareAndSet(false, true)) return
        scope.launch(Dispatchers.IO) {
            try {
                _state.update { it.copy(status = RealtimeStatus.SYNCING) }
                repeat(RECOVERY_PAGES) {
                    val page = client.request("sync/changes?cursor=$cursor&limit=$RECOVERY_PAGE")
                    val list = page.optJSONArray("events") ?: return@launch
                    for (index in 0 until list.length()) {
                        list.optJSONObject(index)?.let { apply(it) }
                    }
                    val next = page.optLong("cursor", cursor)
                    if (next > cursor) cursor = next
                    if (!page.optBoolean("more")) return@launch
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update {
                    it.copy(
                        status = RealtimeStatus.SYNC_ERROR,
                        lastError = error.message ?: "Could not synchronise missed changes.",
                    )
                }
            } finally {
                recovering.set(false)
                _state.update { it.copy(pending = 0) }
            }
        }
    }

    // ------------------------------------------------------------- endpoints ---

    private data class Endpoint(val host: String, val port: Int, val path: String, val secure: Boolean)

    /**
     * Resolves the gateway from `GET /api/health`, which advertises the port and
     * path — the client never has to guess a second port.
     */
    private suspend fun resolveEndpoint(): Endpoint? {
        val base = client.baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) return null
        val health = runCatching { client.request("health") }.getOrNull()
        val realtime = health?.optJSONObject("realtime")
        val path = realtime?.optString("path")?.takeIf { it.isNotBlank() } ?: "/api/realtime"
        val advertised = realtime?.optInt("port") ?: 0
        val uri = runCatching { URI(base) }.getOrNull() ?: return null
        val secure = uri.scheme.equals("https", ignoreCase = true)
        val port = when {
            advertised > 0 -> advertised
            uri.port > 0 -> uri.port
            secure -> 443
            else -> 80
        }
        val host = uri.host ?: return null
        return Endpoint(host, port, path, secure)
    }

    private fun openSocket(endpoint: Endpoint): Socket {
        val raw = Socket()
        raw.tcpNoDelay = true
        raw.connect(InetSocketAddress(endpoint.host, endpoint.port), CONNECT_TIMEOUT_MS)
        if (!endpoint.secure) return raw
        val tls = (SSLSocketFactory.getDefault() as SSLSocketFactory)
            .createSocket(raw, endpoint.host, endpoint.port, true) as Socket
        return tls
    }

    /** Minimal RFC 6455 client handshake, reusing the app's own session cookie. */
    private suspend fun handshake(socket: Socket, endpoint: Endpoint, cookie: String) = withContext(Dispatchers.IO) {
        val keyBytes = ByteArray(16).also { random.nextBytes(it) }
        val key = android.util.Base64.encodeToString(keyBytes, android.util.Base64.NO_WRAP)
        val host = endpoint.host
        val request = buildString {
            append("GET ${endpoint.path} HTTP/1.1\r\n")
            append("Host: $host:${endpoint.port}\r\n")
            append("Upgrade: websocket\r\n")
            append("Connection: Upgrade\r\n")
            append("Sec-WebSocket-Key: $key\r\n")
            append("Sec-WebSocket-Version: 13\r\n")
            append("Cookie: $cookie\r\n")
            append("User-Agent: MobileCloud-Android\r\n")
            append("\r\n")
        }
        socket.getOutputStream().write(request.toByteArray(Charsets.UTF_8))
        socket.getOutputStream().flush()

        val input = socket.getInputStream()
        val header = StringBuilder()
        while (!header.endsWith("\r\n\r\n")) {
            val byte = input.read()
            if (byte == -1) throw CloudException("The realtime gateway closed the connection.")
            header.append(byte.toChar())
            if (header.length > 16_384) throw CloudException("The realtime gateway sent an invalid response.")
        }
        val statusLine = header.lineSequence().firstOrNull().orEmpty()
        if (!statusLine.contains("101")) {
            // 401 means "authenticate" — never confuse it with "unreachable".
            throw if (statusLine.contains("401")) CloudException("Sign in required") else CloudException("Realtime upgrade refused: $statusLine")
        }
    }

    private fun sessionCookie(): String? {
        val manager = CookieHandler.getDefault() as? CookieManager ?: return null
        val session = manager.cookieStore.cookies.firstOrNull { it.name == "mc_session" } ?: return null
        return "${session.name}=${session.value}"
    }

    // ---------------------------------------------------------------- frames ---

    private data class Frame(val fin: Boolean, val opcode: Int, val payload: ByteArray)

    private fun readFrame(input: InputStream): Frame? {
        val first = input.read()
        if (first == -1) return null
        val second = input.read()
        if (second == -1) return null
        val fin = (first and 0x80) != 0
        val opcode = first and 0x0f
        val masked = (second and 0x80) != 0
        var length = (second and 0x7f).toLong()
        if (length == 126L) length = readExact(input, 2).let { ((it[0].toInt() and 0xff) shl 8) or (it[1].toInt() and 0xff) }.toLong()
        else if (length == 127L) {
            val bytes = readExact(input, 8)
            length = 0
            for (byte in bytes) length = (length shl 8) or (byte.toLong() and 0xff)
        }
        if (length > MAX_FRAME) throw CloudException("Realtime frame exceeded the size limit.")
        val mask = if (masked) readExact(input, 4) else null
        val payload = readExact(input, length.toInt())
        if (mask != null) for (index in payload.indices) payload[index] = (payload[index].toInt() xor mask[index and 3].toInt()).toByte()
        return Frame(fin, opcode, payload)
    }

    private fun readExact(input: InputStream, count: Int): ByteArray {
        val out = ByteArray(count)
        var offset = 0
        while (offset < count) {
            val read = input.read(out, offset, count - offset)
            if (read == -1) throw CloudException("The realtime connection ended mid-frame.")
            offset += read
        }
        return out
    }

    private fun writeFrame(out: OutputStream, opcode: Int, payload: ByteArray, mask: Boolean) {
        val header = ByteArrayOutputStream()
        header.write(0x80 or opcode)
        val maskBit = if (mask) 0x80 else 0
        val length = payload.size
        when {
            length < 126 -> header.write(maskBit or length)
            length < 65536 -> {
                header.write(maskBit or 126)
                header.write((length shr 8) and 0xff)
                header.write(length and 0xff)
            }
            else -> {
                header.write(maskBit or 127)
                for (shift in 7 downTo 0) header.write(((length.toLong() shr (shift * 8)) and 0xff).toInt())
            }
        }
        val body: ByteArray
        if (mask) {
            val key = ByteArray(4).also { random.nextBytes(it) }
            header.write(key)
            body = ByteArray(length) { index -> (payload[index].toInt() xor key[index and 3].toInt()).toByte() }
        } else {
            body = payload
        }
        out.write(header.toByteArray())
        out.write(body)
        out.flush()
    }

    private fun send(socket: Socket, message: JSONObject) {
        writeFrame(socket.getOutputStream(), OP_TEXT, message.toString().toByteArray(Charsets.UTF_8), mask = true)
    }

    private fun closeSocket() {
        val current = socket ?: return
        socket = null
        runCatching {
            writeFrame(current.getOutputStream(), OP_CLOSE, ByteArray(0), mask = true)
        }
        runCatching { current.close() }
    }

    private fun readCursor(): Long = prefs?.getLong(KEY_CURSOR, 0L) ?: 0L

    companion object {
        private const val TAG = "MobileCloud"
        private const val KEY_CURSOR = "realtime_cursor"
        private const val OP_CONT = 0x0
        private const val OP_TEXT = 0x1
        private const val OP_BINARY = 0x2
        private const val OP_CLOSE = 0x8
        private const val OP_PING = 0x9
        private const val OP_PONG = 0xa
        private const val CONNECT_TIMEOUT_MS = 8_000
        private const val DEAD_MS = 75_000
        private const val HEARTBEAT_MS = 20_000L
        private const val MAX_BACKOFF_MS = 30_000L
        private const val MAX_FRAME = 256 * 1024
        private const val SEEN_LIMIT = 2_000
        private const val RECOVERY_PAGE = 500
        private const val RECOVERY_PAGES = 40
    }
}
