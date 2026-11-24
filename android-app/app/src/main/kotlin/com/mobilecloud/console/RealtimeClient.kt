package com.mobilecloud.console

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.Locale
import javax.net.ssl.SSLException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.random.Random

/** Realtime connection states shown in the UI. */
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

/**
 * The console reads full authenticated snapshots, not an event-applied local cache.
 * The socket invalidates a snapshot on welcome (including reconnect) or a live
 * account event. No durable cursor is advanced ahead of a successful refresh.
 */
class RealtimeClient(private val scope: CoroutineScope) {
    internal data class Invalidation(val client: CloudClient, val revision: Long)

    private class Generation(val client: CloudClient, val accountId: String) {
        var job: Job? = null
        var rawSocket: Socket? = null
        var welcomed = false
    }

    private val lock = Any()
    private val random = SecureRandom()
    private var active: Generation? = null
    private var revision = 0L
    private val _state = MutableStateFlow(RealtimeState(status = RealtimeStatus.OFFLINE))
    val state = _state.asStateFlow()
    private val _invalidations = MutableStateFlow<Invalidation?>(null)
    internal val invalidations = _invalidations.asStateFlow()

    internal fun start(client: CloudClient, accountId: String): Unit = synchronized(lock) {
        if (active?.let { it.client === client && it.accountId == accountId } == true) return@synchronized
        stopLocked()
        val generation = Generation(client, accountId)
        active = generation
        _state.value = RealtimeState()
        generation.job = scope.launch(Dispatchers.IO, start = CoroutineStart.LAZY) { runLoop(generation) }
        generation.job?.start()
    }

    fun stop() = synchronized(lock) { stopLocked() }

    private fun stopLocked() {
        val previous = active
        active = null
        previous?.job?.cancel()
        previous?.rawSocket?.let { runCatching { it.close() } }
        _state.value = RealtimeState(status = RealtimeStatus.OFFLINE)
        _invalidations.value = null
    }

    private fun update(generation: Generation, transform: (RealtimeState) -> RealtimeState): Unit = synchronized(lock) {
        if (active === generation) _state.value = transform(_state.value)
    }

    private fun invalidate(generation: Generation) = synchronized(lock) {
        if (active === generation) _invalidations.value = Invalidation(generation.client, ++revision)
    }

    private suspend fun runLoop(generation: Generation) {
        var attempts = 0
        while (currentCoroutineContext().isActive) {
            generation.welcomed = false
            val failure = try {
                pump(generation)
                "The realtime connection closed."
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (error is CloudException && error.status == 401) {
                    update(generation) { it.copy(status = RealtimeStatus.SYNC_ERROR, lastError = error.message) }
                    invalidate(generation) // REST verifies whether the current session is still valid.
                    return
                }
                when (error) {
                    is CloudException -> error.message ?: "Realtime failed."
                    is SSLException -> "Could not verify the realtime TLS connection."
                    else -> "Could not reach the realtime gateway."
                }
            }
            if (!currentCoroutineContext().isActive) return
            attempts = if (generation.welcomed) 1 else (attempts + 1).coerceAtMost(20)
            update(generation) { it.copy(status = RealtimeStatus.RECONNECTING, attempts = attempts, lastError = failure) }
            val ceiling = (500L shl (attempts - 1).coerceAtMost(6)).coerceAtMost(30_000L)
            delay(Random.nextLong(ceiling / 2, ceiling))
        }
    }

    private suspend fun pump(generation: Generation) {
        val client = generation.client
        val path = ConsoleDiscovery.websocketPath(client.health())
            ?: throw CloudException("This console did not advertise a supported realtime path.")
        val origin = client.origin
        val raw = Socket()
        try {
            synchronized(lock) {
                if (active !== generation) throw CancellationException()
                generation.rawSocket = raw
            }
            raw.tcpNoDelay = true
            raw.connect(InetSocketAddress(origin.host, origin.port), CONNECT_TIMEOUT)
            raw.soTimeout = CONNECT_TIMEOUT
            val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
            (factory.createSocket(raw, origin.host, origin.port, true) as SSLSocket).use { tls ->
                tls.soTimeout = CONNECT_TIMEOUT
                tls.sslParameters = tls.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
                tls.startHandshake() // Verify the chain and the HTTPS hostname before selecting/sending cookies.
                val cookie = client.websocketCookie(path) ?: throw CloudException("Sign in required.", 401)
                val input = BufferedInputStream(tls.inputStream)
                val output = tls.outputStream
                handshake(input, output, origin, path, cookie)
                receive(generation, tls, input, output)
            }
        } finally {
            runCatching { raw.close() }
            synchronized(lock) {
                if (generation.rawSocket === raw) generation.rawSocket = null
            }
        }
    }

    private fun handshake(input: InputStream, output: OutputStream, origin: ConsoleOrigin, path: String, cookie: String) {
        val key = Base64.getEncoder().encodeToString(ByteArray(16).also(random::nextBytes))
        val request = "GET $path HTTP/1.1\r\nHost: ${origin.authority}\r\nOrigin: ${origin.url}\r\nUpgrade: websocket\r\n" +
            "Connection: Upgrade\r\nSec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\n" +
            "Cookie: $cookie\r\nUser-Agent: MobileCloud-Android\r\n\r\n"
        output.write(request.toByteArray(Charsets.US_ASCII))
        output.flush()

        val started = System.nanoTime()
        val header = StringBuilder()
        while (!header.endsWith("\r\n\r\n")) {
            if (header.length >= 16_384 || elapsedMillis(started) >= CONNECT_TIMEOUT) invalidHandshake()
            val byte = input.read()
            if (byte < 0) invalidHandshake()
            header.append(byte.toChar())
        }
        validateUpgrade(header.toString(), key)
    }

    private suspend fun receive(generation: Generation, tls: SSLSocket, input: InputStream, output: OutputStream) {
        // All writes happen here, on the reader's coroutine. No old heartbeat,
        // ack, or recovery job can write to another connection.
        var fragments: ByteArrayOutputStream? = null
        val openedAt = System.nanoTime()
        while (currentCoroutineContext().isActive) {
            if (!generation.welcomed && elapsedMillis(openedAt) >= CONNECT_TIMEOUT) invalidFrame()
            val frame = readFrame(input) ?: return
            when (frame.opcode) {
                OP_PING -> writeControl(output, OP_PONG, frame.payload)
                OP_PONG -> Unit
                OP_CLOSE -> {
                    if (frame.payload.size == 1) invalidFrame()
                    writeControl(output, OP_CLOSE, frame.payload)
                    return
                }
                OP_TEXT -> {
                    if (fragments != null) invalidFrame()
                    if (frame.fin) handleText(generation, tls, output, frame.payload)
                    else fragments = ByteArrayOutputStream().also { it.write(frame.payload) }
                }
                OP_CONT -> {
                    val message = fragments ?: invalidFrame()
                    if (message.size() + frame.payload.size > MAX_MESSAGE) invalidFrame()
                    message.write(frame.payload)
                    if (frame.fin) {
                        fragments = null
                        handleText(generation, tls, output, message.toByteArray())
                    }
                }
            }
        }
    }

    private fun handleText(generation: Generation, tls: SSLSocket, output: OutputStream, payload: ByteArray) {
        val text = Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(payload)).toString()
        val message = CloudClient.parseObject(text)
        when (message.opt("type")) {
            "welcome" -> {
                if (generation.welcomed || message.opt("schema_version") != 1) invalidFrame()
                if (message.opt("account_id") != generation.accountId) {
                    throw CloudException("The realtime gateway did not verify this account.", 401)
                }
                generation.welcomed = true
                tls.soTimeout = DEAD_TIMEOUT
                update(generation) {
                    RealtimeState(
                        status = RealtimeStatus.CONNECTED,
                        accountId = generation.accountId,
                        accountName = message.opt("account_name") as? String,
                        via = "WSS",
                    )
                }
                // The gateway subscribes this connection to live account events by default.
                // Refresh from REST instead of replaying historical changes into a snapshot UI.
                invalidate(generation)
            }
            "event" -> {
                val event = message.optJSONObject("event") ?: invalidFrame()
                if (!generation.welcomed || event.opt("account_id") != generation.accountId) invalidFrame()
                if (!event.optBoolean("ephemeral")) {
                    update(generation) { it.copy(cursor = maxOf(it.cursor, event.optLong("sequence"))) }
                    invalidate(generation)
                }
            }
            "ping" -> writeControl(output, OP_PONG, ByteArray(0)) // Gateway counts WS control frames as activity.
            "error" -> when (message.opt("code")) {
                "unauthorized", "unauthenticated" -> throw CloudException("The realtime session is not authorized.", 401)
                else -> update(generation) { it.copy(lastError = "The realtime gateway reported an error.") }
            }
        }
    }

    internal fun snapshotRefreshed(client: CloudClient, timestamp: Long): Unit = synchronized(lock) {
        if (active?.client === client) _state.value = _state.value.copy(lastSyncAt = timestamp)
    }

    private data class Frame(val fin: Boolean, val opcode: Int, val payload: ByteArray)

    private fun readFrame(input: InputStream): Frame? {
        val first = input.read()
        if (first == -1) return null
        val started = System.nanoTime()
        val second = input.read()
        val fin = first and 0x80 != 0
        val opcode = first and 0x0f
        if (second < 0 || first and 0x70 != 0 || second and 0x80 != 0) invalidFrame()
        val control = opcode in listOf(OP_PING, OP_PONG, OP_CLOSE)
        var size = (second and 0x7f).toLong()
        if ((control && (!fin || size > 125)) || (!control && opcode != OP_TEXT && opcode != OP_CONT)) invalidFrame()
        if (size == 126L || size == 127L) {
            val extended = size == 127L
            val octets = readExact(input, if (extended) 8 else 2, started)
            if (extended && octets[0].toInt() and 0x80 != 0) invalidFrame()
            size = 0
            for (byte in octets) size = (size shl 8) or (byte.toLong() and 0xff)
            if (size < (if (extended) 65536 else 126)) invalidFrame()
        }
        if (size > MAX_MESSAGE) invalidFrame()
        return Frame(fin, opcode, readExact(input, size.toInt(), started))
    }

    private fun readExact(input: InputStream, count: Int, started: Long): ByteArray {
        val result = ByteArray(count)
        var offset = 0
        while (offset < count) {
            if (elapsedMillis(started) >= DEAD_TIMEOUT) invalidFrame()
            val bytes = input.read(result, offset, count - offset)
            if (bytes < 0) invalidFrame()
            offset += bytes
        }
        return result
    }

    private fun writeControl(output: OutputStream, opcode: Int, payload: ByteArray) {
        val mask = ByteArray(4).also(random::nextBytes)
        val frame = ByteArray(6 + payload.size)
        frame[0] = (0x80 or opcode).toByte()
        frame[1] = (0x80 or payload.size).toByte()
        mask.copyInto(frame, 2)
        for (index in payload.indices) frame[6 + index] = (payload[index].toInt() xor mask[index and 3].toInt()).toByte()
        output.write(frame)
        output.flush()
    }

    companion object {
        private const val CONNECT_TIMEOUT = 8_000
        private const val DEAD_TIMEOUT = 75_000
        private const val MAX_MESSAGE = 256 * 1024
        private const val OP_CONT = 0x0
        private const val OP_TEXT = 0x1
        private const val OP_CLOSE = 0x8
        private const val OP_PING = 0x9
        private const val OP_PONG = 0xa
        private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

        private fun invalidHandshake(): Nothing = throw CloudException("The realtime gateway sent an invalid upgrade response.")
        private fun invalidFrame(): Nothing = throw CloudException("The realtime gateway sent an invalid message.")
        private fun elapsedMillis(started: Long) = (System.nanoTime() - started) / 1_000_000

        internal fun validateUpgrade(header: String, key: String) {
            val lines = header.removeSuffix("\r\n\r\n").split("\r\n")
            val status = lines.first().split(' ', limit = 3)
            if (status.getOrNull(0) != "HTTP/1.1") invalidHandshake()
            if (status.getOrNull(1) == "401") throw CloudException("Sign in required.", 401)
            if (status.getOrNull(1) != "101") invalidHandshake()
            val fields = mutableMapOf<String, MutableList<String>>()
            for (line in lines.drop(1)) {
                val colon = line.indexOf(':')
                if (colon <= 0) invalidHandshake()
                val name = line.substring(0, colon).lowercase(Locale.ROOT)
                if (!HEADER_NAME.matches(name)) invalidHandshake()
                fields.getOrPut(name) { mutableListOf() }.add(line.substring(colon + 1).trim())
            }
            val accept = Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-1").digest((key + WS_GUID).toByteArray(Charsets.US_ASCII)),
            )
            if (fields["upgrade"]?.singleOrNull()?.equals("websocket", ignoreCase = true) != true ||
                fields["connection"].orEmpty().none { value -> value.split(',').any { it.trim().equals("upgrade", ignoreCase = true) } } ||
                fields["sec-websocket-accept"]?.singleOrNull() != accept ||
                "sec-websocket-protocol" in fields || "sec-websocket-extensions" in fields
            ) invalidHandshake()
        }

        private val HEADER_NAME = Regex("[a-z0-9!#$%&'*+.^_`|~-]+")
    }
}
