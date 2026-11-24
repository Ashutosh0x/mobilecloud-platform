package com.mobilecloud.console

import android.net.InetAddresses
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpCookie
import java.net.URI
import java.net.URL
import java.util.Locale
import javax.net.ssl.HttpsURLConnection

/** Safe client-facing text and an optional HTTP status, never a raw server error. */
class CloudException(message: String, val status: Int? = null) : Exception(message)

/** The complete credential boundary: HTTPS, one canonical host, and one port. */
internal class ConsoleOrigin private constructor(val host: String, val port: Int) {
    val authority = (if (':' in host) "[$host]" else host) + if (port == 443) "" else ":$port"
    val url = "https://$authority"

    fun isLocalOnly(): Boolean {
        val name = host.trimEnd('.')
        if (name == "localhost" || name.endsWith(".localhost")) return true
        // No DNS during ticket parsing: only examine IP literals here.
        if (':' !in name && name.any { it !in "0123456789." }) return false
        val address = runCatching { InetAddresses.parseNumericAddress(name) }.getOrNull() ?: return false
        return address.isLoopbackAddress || address.isAnyLocalAddress
    }

    companion object {
        fun parse(value: String): ConsoleOrigin? {
            val uri = runCatching { URI(value.trim()).parseServerAuthority() }.getOrNull() ?: return null
            if (!uri.scheme.equals("https", ignoreCase = true) || uri.rawUserInfo != null ||
                uri.rawQuery != null || uri.rawFragment != null || uri.rawPath !in listOf("", "/") ||
                uri.rawAuthority?.endsWith(':') != false
            ) return null
            val host = uri.host?.removeSurrounding("[", "]")?.lowercase(Locale.ROOT) ?: return null
            if ('%' in host || host.length > 253) return null
            // Reject ambiguous legacy numeric addresses such as 127.1 or a single integer.
            if (host.all { it in "0123456789." }) {
                val octets = host.split('.')
                if (octets.size != 4 || octets.any { value ->
                        val number = value.toIntOrNull()
                        number == null || number !in 0..255 || number.toString() != value
                    }
                ) return null
            }
            val port = if (uri.port == -1) 443 else uri.port
            return if (port in 1..65535) ConsoleOrigin(host, port) else null
        }
    }
}

/** One in-memory cookie jar per connection, including while sign-in/pairing is staged. */
class CloudClient internal constructor(internal val origin: ConsoleOrigin) {
    private val lock = Any()
    private val cookies = LinkedHashMap<Pair<String, String>, HttpCookie>()
    private var closed = false

    internal fun close() = synchronized(lock) {
        closed = true
        cookies.clear()
    }

    /** Detach a single-use logout client without leaving the old client available for writes. */
    internal fun takeForLogout(): CloudClient = synchronized(lock) {
        CloudClient(origin).also { it.cookies.putAll(cookies) }.also { close() }
    }

    internal fun websocketCookie(path: String): String? = synchronized(lock) {
        // The raw gateway needs only the session cookie, never CSRF or gate cookies.
        selectCookies(path).firstOrNull { it.name == SESSION }?.let { "$SESSION=${it.value}" }
    }

    internal fun hasSession(): Boolean = synchronized(lock) {
        selectCookies("/api/auth/me").any { it.name == SESSION }
    }

    private fun selectCookies(path: String): List<HttpCookie> {
        checkOpen()
        cookies.values.removeAll { it.hasExpired() }
        return cookies.values.filter { matchesPath(path, it.path) }.sortedByDescending { it.path.length }.distinctBy { it.name }
    }

    private fun checkOpen() {
        if (closed) throw CloudException("This console connection changed.")
    }

    private fun saveCookies(path: String, headers: Map<String?, List<String>>) = synchronized(lock) {
        checkOpen()
        for ((name, values) in headers) {
            if (!name.equals("Set-Cookie", ignoreCase = true)) continue
            for (header in values) {
                if (header.length > 8192) continue
                // Some proxies join multiple Set-Cookie values; don't split the comma in Expires.
                for (value in COOKIE_BOUNDARY.split(header)) {
                    val cookie = runCatching { HttpCookie.parse(value).singleOrNull() }.getOrNull() ?: continue
                    if (cookie.name !in COOKIE_NAMES || !COOKIE_VALUE.matches(cookie.value)) continue
                    val domain = cookie.domain?.trimStart('.')
                    if (domain != null && !domain.equals(origin.host, ignoreCase = true)) continue
                    cookie.path = cookie.path?.takeIf { it.startsWith('/') } ?: path.substringBeforeLast('/').ifEmpty { "/" }
                    val key = cookie.name to cookie.path
                    if (cookie.value.isEmpty() || cookie.hasExpired()) cookies.remove(key)
                    else if (cookies.size < 32 || key in cookies) cookies[key] = cookie
                }
            }
        }
    }

    suspend fun request(path: String, method: String = "GET", body: String? = null): JSONObject =
        request(path, method, body, authenticated = true)

    internal suspend fun health(): JSONObject = request("health", "GET", null, authenticated = false)

    private suspend fun request(path: String, method: String, body: String?, authenticated: Boolean): JSONObject =
        withContext(Dispatchers.IO) {
            val resource = path.substringBefore('?')
            if (!API_PATH.matches(resource) || path.any { it <= ' ' || it == '#' || it == '\u007f' }) {
                throw CloudException("Invalid API path.")
            }
            val requestPath = "/api/$resource"
            val mutating = method in MUTATIONS
            val selected = synchronized(lock) {
                if (authenticated) selectCookies(requestPath) else emptyList()
            }
            val connection = URL("${origin.url}/api/$path").openConnection() as HttpsURLConnection
            try {
                connection.requestMethod = method
                connection.connectTimeout = if (authenticated) 12_000 else 4_000
                connection.readTimeout = if (authenticated) 20_000 else 4_000
                connection.instanceFollowRedirects = false
                connection.useCaches = false
                connection.setRequestProperty("Accept", "application/json")
                if (selected.isNotEmpty()) {
                    connection.setRequestProperty("Cookie", selected.joinToString("; ") { "${it.name}=${it.value}" })
                }
                if (mutating) {
                    selected.firstOrNull { it.name == CSRF }?.let { connection.setRequestProperty("X-MC-CSRF", it.value) }
                }
                ensureActive()
                synchronized(lock) { checkOpen() }
                if (body != null || mutating) {
                    val bytes = body?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json")
                    // Stream writes (even empty POST/PATCH/DELETE); do not buffer a replayable body.
                    connection.setFixedLengthStreamingMode(bytes.size)
                    connection.outputStream.use { it.write(bytes) }
                }
                val status = connection.responseCode
                ensureActive()
                if (status !in 200..299) throw httpError(status)
                val json = connection.inputStream.use { stream ->
                    val buffer = ByteArray(8192)
                    val result = ByteArrayOutputStream()
                    val maxBytes = if (authenticated) MAX_BODY else 16 * 1024
                    val started = System.nanoTime()
                    while (true) {
                        ensureActive()
                        if ((System.nanoTime() - started) / 1_000_000 >= connection.readTimeout) {
                            throw IOException("Response deadline exceeded.")
                        }
                        val count = stream.read(buffer)
                        if (count < 0) break
                        if (result.size() + count > maxBytes) throw CloudException("The response is too large.")
                        result.write(buffer, 0, count)
                    }
                    parseObject(result.toString("UTF-8"))
                }
                ensureActive()
                if (authenticated) saveCookies(requestPath, connection.headerFields)
                json
            } finally {
                connection.disconnect()
            }
        }

    companion object {
        private const val SESSION = "mc_session"
        private const val CSRF = "mc_csrf"
        private val COOKIE_NAMES = setOf(SESSION, CSRF, "mc_gate")
        private val COOKIE_BOUNDARY = Regex(",\\s*(?=[A-Za-z0-9_!#$%&'*+.^`|~-]+=)")
        // These API cookies are opaque base64url/hex tokens, not arbitrary header text.
        private val COOKIE_VALUE = Regex("[A-Za-z0-9_-]{0,512}")
        private val API_PATH = Regex("[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*")
        private val MUTATIONS = setOf("POST", "PUT", "PATCH", "DELETE")
        private const val MAX_BODY = 4 * 1024 * 1024

        private fun matchesPath(request: String, cookie: String): Boolean =
            request == cookie || (request.startsWith(cookie) && (cookie.endsWith('/') || request.getOrNull(cookie.length) == '/'))

        internal fun parseObject(text: String): JSONObject {
            val tokener = JSONTokener(text)
            return runCatching {
                (tokener.nextValue() as? JSONObject)?.takeIf { tokener.nextClean() == '\u0000' }
            }.getOrNull() ?: throw CloudException("The console returned an invalid response.")
        }

        private fun httpError(code: Int): CloudException = CloudException(when (code) {
            in 300..399 -> "The console redirected the request. Use its final HTTPS address."
            400 -> "The console rejected the request. Check the details and try again."
            401 -> "Sign-in was not accepted."
            403 -> "The console blocked this request."
            404 -> "This console operation is not available."
            409 -> "The request conflicts with the console's current state."
            410 -> "This request is no longer valid."
            429 -> "Too many requests. Wait before trying again."
            else -> "The console could not complete the request (HTTP $code)."
        }, code)
    }
}
