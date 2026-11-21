package com.mobilecloud.work

import java.net.HttpURLConnection
import java.net.URL

/**
 * Loopback client for the on-device `mobilecloud-core` supervisor daemon
 * (127.0.0.1:3000, behind Caddy per config/Caddyfile). Workers use it as the
 * single data source for widget state; every failure degrades to "keep last
 * known state" so widgets never render empty on flaky connectivity.
 *
 * Loopback cleartext is the ONLY permitted exception in
 * res/xml/network_security_config.xml (GitHub defense-in-depth pattern,
 * decompilation report §17.3 #9).
 */
object CoreEngineProbe {

    private const val BASE = "http://127.0.0.1:3000"
    private const val CONNECT_TIMEOUT_MS = 3_000
    private const val READ_TIMEOUT_MS = 3_000

    /** GET a daemon path, returning the body or null on any failure. */
    fun get(path: String): String? = runCatching {
        val conn = URL(BASE + path).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.requestMethod = "GET"
            conn.useCaches = false
            if (conn.responseCode !in 200..299) return null
            conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }.getOrNull()
}
