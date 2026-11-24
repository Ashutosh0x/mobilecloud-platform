package com.mobilecloud.console

import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/** `status` mirrors the web `CloudState.status` union. */
enum class ConsoleStatus { LOADING, ANON, READY, ERROR }

/**
 * Why the control plane is (or is not) usable, kept distinct from the HTTP
 * status so the UI never reports the wrong cause:
 *
 *  - `AUTH_REQUIRED` / `AUTHENTICATION_FAILED` are *not* network failures,
 *  - `INVALID_ENDPOINT` means the address does not speak the MobileCloud API,
 *  - `NETWORK_UNAVAILABLE` means the device itself has no usable network,
 *  - `SERVER_UNAVAILABLE` means the device is online but the server is not.
 */
enum class ConnectionState {
    INITIALIZING,
    DISCOVERING,
    CONNECTED,
    AUTH_REQUIRED,
    NETWORK_UNAVAILABLE,
    SERVER_UNAVAILABLE,
    INVALID_ENDPOINT,
    AUTHENTICATION_FAILED,
}

/**
 * Compose state holder for the web-parity console — a 1:1 port of the Next.js
 * `StoreProvider` in `lib/store.tsx` (`refresh`, `call`, `login`, `logout`,
 * `pushShell`, `setToast`, `setRange`) wired to [CloudClient] instead of
 * same-origin `fetch`.
 *
 * The console URL is persisted so a phone pointed at a web console stays
 * pointed at it across launches.
 */
class ConsoleStore(
    private val scope: CoroutineScope,
    private val prefs: SharedPreferences? = null,
    private val context: Context? = null,
) {

    val client = CloudClient()

    /** The one realtime client for the whole app — never one per screen. */
    val realtime = RealtimeClient(scope, client, prefs)

    var baseUrl by mutableStateOf(prefs?.getString(KEY_URL, "").orEmpty())
        private set
    var status by mutableStateOf(ConsoleStatus.LOADING)
        private set
    var connection by mutableStateOf(ConnectionState.INITIALIZING)
        private set
    var connectionMethod by mutableStateOf<String?>(null)
        private set
    var lastHealthAt by mutableStateOf<Long?>(null)
        private set
    var realtimeState by mutableStateOf(RealtimeState())
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var toast by mutableStateOf<String?>(null)
        private set
    var query by mutableStateOf<String>("")
        private set
    var range by mutableStateOf("24h")
        private set
    var busy by mutableStateOf(false)
        private set

    var user by mutableStateOf<User?>(null)
        private set
    var snapshot by mutableStateOf<Snapshot?>(null)
        private set
    var analytics by mutableStateOf<Analytics?>(null)
        private set
    var shell by mutableStateOf(listOf("CloudShell reads this server. Type help."))
        private set

    private var pollJob: Job? = null
    private var toastJob: Job? = null
    private var refreshJob: Job? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    init {
        client.baseUrl = baseUrl
        // Mirror the realtime client's state into Compose state.
        scope.launch {
            realtime.state.collect { realtimeState = it }
        }
        // A live event means the server moved: re-pull the snapshot so every
        // page reflects it. Debounced so a burst causes one refresh.
        scope.launch {
            realtime.events.collect {
                refreshJob?.cancel()
                refreshJob = scope.launch {
                    delay(250)
                    runCatching { refresh() }
                }
            }
        }
    }

    /** True when the device has a usable network at all. */
    fun networkAvailable(): Boolean {
        val manager = context?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
        val network = manager.activeNetwork ?: return false
        val caps = manager.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /**
     * Reconnects the realtime socket whenever the device's network changes —
     * Wi-Fi to mobile data, VPN up/down, or coming back from offline.
     */
    private fun registerNetworkCallback() {
        val manager = context?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        if (networkCallback != null) return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                Log.i(TAG, "network available — reconnecting realtime")
                // The previously validated endpoint may belong to the old
                // network (Wi-Fi → mobile data), so revalidate rather than reuse.
                ConsoleDiscovery.invalidate()
                realtime.retry()
                scope.launch { runCatching { refresh() } }
            }

            override fun onLost(network: Network) {
                Log.i(TAG, "network lost")
                ConsoleDiscovery.invalidate()
                scope.launch { refresh() }
            }
        }
        networkCallback = callback
        runCatching {
            manager.registerNetworkCallback(
                NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build(),
                callback,
            )
        }.onFailure { Log.w(TAG, "could not register network callback", it) }
    }

    private fun unregisterNetworkCallback() {
        val manager = context?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        networkCallback?.let { runCatching { manager.unregisterNetworkCallback(it) } }
        networkCallback = null
    }

    /**
     * Persist + apply the control-plane origin, e.g. `http://10.0.2.2:3000`.
     * A blank value is ignored: discovery must never clobber a working address
     * with an empty one.
     */
    fun applyBaseUrl(url: String) {
        val clean = url.trim().trimEnd('/')
        if (clean.isEmpty()) return
        baseUrl = clean
        client.baseUrl = clean
        prefs?.edit()?.putString(KEY_URL, clean)?.apply()
        Log.i(TAG, "control-plane base URL = $clean")
    }

    fun editQuery(value: String) {
        query = value
    }

    fun chooseRange(value: String) {
        if (value == range) return
        range = value
        scope.launch { runCatching { refresh() } }
    }

    fun pushShell(line: String) {
        shell = (shell + line).takeLast(40)
    }

    fun showToast(value: String?) {
        toast = value
    }

    /** Transient toast that clears itself, matching the web 2.5 s toast. */
    fun notify(message: String) {
        toast = message
        toastJob?.cancel()
        toastJob = scope.launch {
            delay(2_600)
            if (toast == message) toast = null
        }
    }

    /** `auth/me` → `overview` + `analytics?range=` — identical to web `refresh()`. */
    suspend fun refresh() {
        val started = System.currentTimeMillis()
        try {
            val payload = withDiscovery {
                val me = client.request("auth/me")
                val account = parseUserEnvelope(me)
                if (account == null) return@withDiscovery null
                val snapJson = client.request("overview")
                val analyticsJson = client.request("analytics?range=$range")
                Triple(account, parseSnapshot(snapJson), parseAnalytics(analyticsJson))
            }
            lastHealthAt = System.currentTimeMillis()
            connectionMethod = ConsoleDiscovery.methodFor(baseUrl)
            if (payload == null) {
                user = null
                snapshot = null
                analytics = null
                status = ConsoleStatus.ANON
                connection = ConnectionState.AUTH_REQUIRED
                error = null
                realtime.stop()
                return
            }
            user = payload.first
            snapshot = payload.second
            analytics = payload.third
            status = ConsoleStatus.READY
            connection = ConnectionState.CONNECTED
            error = null
            // Now that there is a session, keep a realtime socket open.
            realtime.start()
            Log.i(TAG, "refresh ok in ${System.currentTimeMillis() - started}ms")
        } catch (e: Exception) {
            Log.w(TAG, "refresh failed against '$baseUrl'", e)
            status = ConsoleStatus.ERROR
            connection = classify(e)
            error = e.message ?: if (snapshot == null) {
                "The control plane is unreachable."
            } else {
                "Lost contact with the control plane."
            }
        }
    }

    /**
     * Turns a failure into an actionable cause. A 401 is an authentication
     * problem, not a network problem, and the UI must say so.
     */
    private fun classify(error: Throwable): ConnectionState = when {
        error is CloudException -> when {
            error.message?.contains("Sign in", ignoreCase = true) == true -> ConnectionState.AUTH_REQUIRED
            error.message?.contains("No control plane", ignoreCase = true) == true -> ConnectionState.INVALID_ENDPOINT
            else -> ConnectionState.AUTHENTICATION_FAILED
        }
        error is UnknownHostException -> ConnectionState.INVALID_ENDPOINT
        error is SocketTimeoutException -> ConnectionState.SERVER_UNAVAILABLE
        error is ConnectException -> ConnectionState.SERVER_UNAVAILABLE
        error is IOException -> if (networkAvailable()) ConnectionState.SERVER_UNAVAILABLE else ConnectionState.NETWORK_UNAVAILABLE
        else -> ConnectionState.SERVER_UNAVAILABLE
    }

    /**
     * Runs [block] against the control plane, self-configuring the base URL when
     * needed: if none is set, or the current one stops answering, [ConsoleDiscovery]
     * finds a reachable one and the block is retried once. This is what makes the
     * connect button "just work" without the user typing an address.
     */
    private suspend fun <T> withDiscovery(block: suspend () -> T): T {
        // Fast path: reuse the saved URL only when it actually answers; a dead
        // address would otherwise stall the request for the full connect timeout.
        if (baseUrl.isBlank() || !ConsoleDiscovery.ping(baseUrl)) {
            Log.i(TAG, "probing for control plane (saved='$baseUrl')")
            connection = ConnectionState.DISCOVERING
            val found = ConsoleDiscovery.discover(baseUrl)
            when {
                found != null -> {
                    applyBaseUrl(found)
                    connectionMethod = ConsoleDiscovery.methodFor(found)
                }
                baseUrl.isBlank() -> {
                    connection = if (networkAvailable()) ConnectionState.INVALID_ENDPOINT else ConnectionState.NETWORK_UNAVAILABLE
                    throw CloudException(NO_PLANE)
                }
                else -> {
                    connection = if (networkAvailable()) ConnectionState.SERVER_UNAVAILABLE else ConnectionState.NETWORK_UNAVAILABLE
                    Log.w(TAG, "no control plane found; keeping '$baseUrl'")
                }
            }
        }
        return try {
            block()
        } catch (e: Exception) {
            if (e is CloudException) throw e            // server answered — nothing to re-detect
            if (baseUrl.isBlank()) throw e
            val found = runCatching { ConsoleDiscovery.discover(baseUrl) }.getOrNull()
            if (found == null || found == baseUrl) throw e
            applyBaseUrl(found)
            connectionMethod = ConsoleDiscovery.methodFor(found)
            block()
        }
    }

    /** Forces a fresh auto-detect and applies the result; returns the URL or null. */
    suspend fun autoDetect(): String? {
        connection = ConnectionState.DISCOVERING
        val found = ConsoleDiscovery.discover(baseUrl)
        if (found != null) {
            applyBaseUrl(found)
            connectionMethod = ConsoleDiscovery.methodFor(found)
        } else {
            connection = if (networkAvailable()) ConnectionState.INVALID_ENDPOINT else ConnectionState.NETWORK_UNAVAILABLE
        }
        return found
    }

    /** Mutation helper: performs the request then refreshes, mirroring web `call()`. */
    suspend fun call(
        path: String,
        body: JSONObject? = null,
        method: String = "POST",
    ): JSONObject {
        busy = true
        try {
            val data = withDiscovery { client.request(path, method, body?.toString()) }
            runCatching { refresh() }
            return data
        } finally {
            busy = false
        }
    }

    suspend fun login(path: String, email: String, password: String, name: String? = null) {
        realtime.reset()
        val body = JSONObject()
            .put("email", email)
            .put("password", password)
        if (name != null) body.put("name", name)
        withDiscovery { client.request(path, "POST", body.toString()) }
        refresh()
    }

    suspend fun logout() {
        runCatching { client.request("auth/logout", "POST") }
        client.clearCookies()
        realtime.reset()
        user = null
        snapshot = null
        analytics = null
        status = ConsoleStatus.ANON
        connection = ConnectionState.AUTH_REQUIRED
    }

    /** Reconnects the socket and re-pulls the snapshot — the diagnostics "Retry". */
    fun retryConnection() {
        realtime.retry()
        scope.launch { runCatching { refresh() } }
    }

    /**
     * Initial load, then a 60 s safety poll that only runs when the realtime
     * socket is *not* connected. While connected, updates arrive over the
     * socket, so there is no polling.
     */
    fun start() {
        scope.launch { refresh() }
        registerNetworkCallback()
        pollJob?.cancel()
        pollJob = scope.launch {
            while (isActive) {
                delay(60_000)
                if (status == ConsoleStatus.READY && realtimeState.status != RealtimeStatus.CONNECTED) {
                    runCatching { refresh() }
                }
            }
        }
    }

    fun stop() {
        pollJob?.cancel()
        pollJob = null
        unregisterNetworkCallback()
        realtime.stop()
    }

    companion object {
        private const val TAG = "MobileCloud"
        private const val KEY_URL = "console_base_url"

        /** Shown when no control plane answers anywhere the phone can reach. */
        const val NO_PLANE =
            "No control plane found. Start the dashboard on your PC (npm run dev --port 3210), " +
                "then plug in USB and retry — the app auto-detects the address."
    }
}
