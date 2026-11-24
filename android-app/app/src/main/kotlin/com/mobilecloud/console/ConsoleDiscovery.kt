package com.mobilecloud.console

import kotlinx.coroutines.CancellationException
import org.json.JSONObject

/** A credential-free probe of the exact HTTPS origin chosen by the user. */
object ConsoleDiscovery {
    suspend fun ping(base: String): Boolean {
        val origin = ConsoleOrigin.parse(base) ?: return false
        val client = CloudClient(origin)
        return try {
            isConsole(client.health())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            false
        } finally {
            client.close()
        }
    }

    internal fun isConsole(health: JSONObject): Boolean =
        health.opt("service") == "MobileCloud" && health.opt("status") == "ok" && health.opt("apiVersion") == 1

    internal fun websocketPath(health: JSONObject): String? {
        if (!isConsole(health)) return null
        val realtime = health.optJSONObject("realtime") ?: return null
        if (realtime.opt("transport") != "websocket" || realtime.opt("schemaVersion") != 1) return null
        // Accept only a relative-to-origin API path. The advertised listener port belongs to
        // the gateway behind the reverse proxy and is not a public credential destination.
        return (realtime.opt("path") as? String)?.takeIf { WS_PATH.matches(it) }
    }

    private val WS_PATH = Regex("/api/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*")
}
