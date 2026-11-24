package com.mobilecloud.console

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.net.HttpURLConnection
import java.net.NetworkInterface
import java.net.URL

/**
 * Finds the MobileCloud control plane without asking the user to type an address,
 * and — just as importantly — never claims success it did not verify.
 *
 * Probe order:
 *  1. the last endpoint that actually answered this session (`cached`),
 *  2. the address stored from a previous run, revalidated rather than trusted,
 *  3. loopback — what a USB cable reaches once the desktop ran
 *     `adb reverse tcp:3210 tcp:3210`,
 *  4. the Android-emulator host alias (`10.0.2.2`),
 *  5. every host on the phone's own network (Wi-Fi / hotspot / VPN) /24.
 *
 * Determinism:
 *  - every candidate is probed with a bounded timeout ([LOOPBACK_TIMEOUT_MS] for
 *    known addresses, [LAN_TIMEOUT_MS] for the bulk /24 sweep),
 *  - the whole search is bounded by [BUDGET_MS] and is cancellable,
 *  - discovery is single-flight, so a burst of callers runs one sweep, not many,
 *  - only an endpoint that answered `/api/health` (or the auth-gated
 *    `/api/overview` on older control planes) as MobileCloud is ever cached, and
 *    a saved URL is revalidated every time instead of being trusted blindly.
 */
object ConsoleDiscovery {

    /** Console ports the web app may serve on (`next dev --port 3210`). */
    private val PORTS = intArrayOf(3210, 3000)

    /** Per-candidate budget for an address we have a reason to expect (2–3 s). */
    private const val LOOPBACK_TIMEOUT_MS = 3_000

    /** Per-candidate budget for the /24 sweep — short, because there are ~500. */
    private const val LAN_TIMEOUT_MS = 800

    /** Overall search budget; the sweep is cancelled rather than hanging. */
    const val BUDGET_MS = 8_000L

    private const val PARALLELISM = 48

    /** Interface prefixes that are never the LAN running the console. */
    private val SKIP_IFACE_PREFIXES = listOf("rmnet", "p2p", "clat", "dummy")

    /** Tri-state probe result: "not our API" is never confused with "no answer". */
    enum class Reach { API, NOT_API, UNREACHABLE }

    /** Last endpoint that answered as MobileCloud this session. */
    @Volatile
    private var cached: String? = null

    private val gate = Mutex()
    private var pending: CompletableDeferred<String?>? = null

    /** Returns a validated base URL, or null when nothing answered. Single-flight. */
    suspend fun discover(stored: String? = null): String? {
        var owner = false
        val flight = gate.withLock {
            val current = pending
            if (current == null || current.isCompleted) {
                owner = true
                CompletableDeferred<String?>().also { pending = it }
            } else {
                current
            }
        }
        // Another caller is already sweeping — wait for its validated answer
        // instead of starting a second, concurrent search.
        if (!owner) return flight.await()

        return try {
            val found = withTimeoutOrNull(BUDGET_MS) { runDiscovery(stored) }
            flight.complete(found)
            found
        } catch (cancelled: Throwable) {
            flight.completeExceptionally(cancelled)
            throw cancelled
        } finally {
            gate.withLock { if (pending === flight) pending = null }
        }
    }

    /** Quick reachability check used by the sign-in screen / fast path. */
    suspend fun ping(base: String): Boolean = withContext(Dispatchers.IO) {
        base.trim().trimEnd('/').takeIf { it.isNotEmpty() }?.let { validate(it, LOOPBACK_TIMEOUT_MS) } == true
    }

    /** Forgets the cached endpoint — called when the device's network changes. */
    fun invalidate() {
        cached = null
    }

    /**
     * Human-readable description of how [base] is reached, shown in diagnostics
     * so the user can tell USB/ADB reverse from a real network path.
     */
    fun methodFor(base: String): String {
        val url = runCatching { URL(base) }.getOrNull() ?: return "Unknown endpoint"
        val host = url.host ?: return "Unknown endpoint"
        val secure = url.protocol.equals("https", ignoreCase = true)
        return when {
            host == "127.0.0.1" || host == "localhost" -> "Loopback · ADB reverse / USB"
            host == "10.0.2.2" -> "Emulator host alias"
            secure -> "Direct HTTPS · validated endpoint"
            isPrivateV4(host) -> "Direct LAN · validated endpoint"
            else -> "Direct · validated endpoint"
        }
    }

    // ------------------------------------------------------------- internals ---

    private suspend fun runDiscovery(stored: String?): String? {
        // 1–2. Revalidate — a saved address that no longer answers must not win.
        val preferred = LinkedHashSet<String>()
        cached?.let { preferred.add(it) }
        stored?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }?.let { preferred.add(it) }
        for (base in preferred) {
            if (validate(base, LOOPBACK_TIMEOUT_MS)) return cache(base)
        }

        // 3–4. Loopback (USB / adb reverse) and the emulator host alias.
        val known = LinkedHashSet<String>()
        for (port in PORTS) {
            known.add("http://127.0.0.1:$port")
            known.add("http://localhost:$port")
            known.add("http://10.0.2.2:$port")
        }
        firstReachable(known.toList(), LOOPBACK_TIMEOUT_MS)?.let { return cache(it) }

        // 5. The phone's own /24 — works when both devices share a network.
        return firstReachable(lanCandidates(), LAN_TIMEOUT_MS)?.let { cache(it) }
    }

    private fun cache(base: String): String {
        cached = base
        return base
    }

    private fun lanCandidates(): List<String> {
        val out = LinkedHashSet<String>()
        val ifaces = runCatching { NetworkInterface.getNetworkInterfaces() }.getOrNull() ?: return emptyList()
        for (iface in ifaces) {
            val name = iface.name.lowercase()
            if (name.startsWith("lo") || SKIP_IFACE_PREFIXES.any { name.startsWith(it) }) continue
            if (runCatching { iface.isUp }.getOrDefault(false).not()) continue
            for (addr in iface.inetAddresses) {
                val ip = addr.hostAddress ?: continue
                if (ip.contains(':')) continue                     // IPv4 only
                if (addr.isLoopbackAddress || !addr.isSiteLocalAddress) continue
                val octets = ip.split('.')
                if (octets.size != 4) continue
                val prefix = octets.take(3).joinToString(".")
                for (port in PORTS) {
                    for (host in 1..254) out.add("http://$prefix.$host:$port")
                }
            }
        }
        return out.toList()
    }

    private suspend fun firstReachable(candidates: List<String>, timeoutMs: Int): String? {
        for (chunk in candidates.chunked(PARALLELISM)) {
            val results = coroutineScope {
                chunk.map { base -> async(Dispatchers.IO) { base to validate(base, timeoutMs) } }.awaitAll()
            }
            results.firstOrNull { it.second }?.let { return it.first }
        }
        return null
    }

    /**
     * True only when [base] serves the MobileCloud API. Prefers the public
     * `/api/health` identity probe; falls back to the auth-gated `/api/overview`
     * for older control planes. A host that did not answer at all is never
     * re-probed, so an unreachable address costs one timeout, not two.
     */
    private fun validate(base: String, timeoutMs: Int): Boolean =
        when (probe("$base/api/health", timeoutMs)) {
            Reach.API -> true
            Reach.NOT_API -> probe("$base/api/overview", timeoutMs) == Reach.API
            Reach.UNREACHABLE -> false
        }

    /**
     * `Reach.API` when the endpoint answered as a MobileCloud control plane,
     * `Reach.NOT_API` when it answered as something else, `Reach.UNREACHABLE`
     * when it did not answer at all.
     */
    private fun probe(url: String, timeoutMs: Int): Reach = try {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            requestMethod = "GET"
            setRequestProperty("accept", "application/json")
            instanceFollowRedirects = false
        }
        try {
            when (val code = conn.responseCode) {
                // 401 → the API is there but wants a sign-in; still our console.
                401 -> Reach.API
                200 -> if (conn.inputStream?.bufferedReader()?.use { it.readText() }
                        ?.contains("MobileCloud") == true) Reach.API else Reach.NOT_API
                else -> Reach.NOT_API
            }
        } finally {
            conn.disconnect()
        }
    } catch (_: Exception) {
        Reach.UNREACHABLE
    }

    private fun isPrivateV4(host: String): Boolean {
        val octets = host.split('.')
        if (octets.size != 4) return false
        val a = octets[0].toIntOrNull() ?: return false
        val b = octets[1].toIntOrNull() ?: return false
        return a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168)
    }
}
