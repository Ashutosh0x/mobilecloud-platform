package com.mobilecloud.console

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.net.CookieHandler
import java.net.CookieManager
import java.net.CookiePolicy
import java.net.HttpURLConnection
import java.net.URL

/** Error carrying the server-provided message, mirroring the web `request()`. */
class CloudException(message: String) : Exception(message)

/**
 * Minimal HTTP client for the MobileCloud control-plane API.
 *
 * Deliberately built on [HttpURLConnection] + [CookieManager] so the app needs
 * no extra dependency and the `mc_session` / `mc_gate` cookies behave exactly
 * like the browser session the Next.js dashboard uses (`credentials: include`).
 */
class CloudClient {

    @Volatile
    var baseUrl: String = ""

    private val cookieManager = CookieManager(null, CookiePolicy.ACCEPT_ALL)

    init {
        CookieHandler.setDefault(cookieManager)
    }

    fun clearCookies() {
        cookieManager.cookieStore.removeAll()
    }

    /**
     * Performs `{baseUrl}/api/{path}`. Throws [CloudException] on a non-2xx
     * response with the server `error` string, matching the web store contract.
     */
    suspend fun request(
        path: String,
        method: String = "GET",
        body: String? = null,
    ): JSONObject = withContext(Dispatchers.IO) {
        val base = baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) throw CloudException("No console URL configured.")
        val conn = (URL("$base/api/$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 12_000
            readTimeout = 20_000
            instanceFollowRedirects = true
            setRequestProperty("accept", "application/json")
            setRequestProperty("content-type", "application/json")
            if (body != null) {
                doOutput = true
            }
        }
        try {
            if (body != null) {
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            val json = if (text.isBlank()) JSONObject() else (runCatching { JSONObject(text) }.getOrNull() ?: JSONObject())
            if (code !in 200..299) {
                val message = json.optString("error").takeIf { it.isNotEmpty() } ?: "Request failed ($code)"
                throw CloudException(message)
            }
            json
        } finally {
            conn.disconnect()
        }
    }
}
