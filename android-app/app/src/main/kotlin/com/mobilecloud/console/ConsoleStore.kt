package com.mobilecloud.console

import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/** `status` mirrors the web `CloudState.status` union. */
enum class ConsoleStatus { LOADING, ANON, READY, ERROR }

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

/** Owns the selected origin, its in-memory session, and the corresponding UI data. Main-thread confined. */
class ConsoleStore(
    private val scope: CoroutineScope,
    private val prefs: SharedPreferences? = null,
    private val context: Context? = null,
) {
    private val savedOrigin = prefs?.getString(KEY_URL, "")?.let(ConsoleOrigin::parse)
    private var session = savedOrigin?.let(::CloudClient)
    private var authAttempt: CloudClient? = null
    val client: CloudClient get() = session ?: throw CloudException(NO_PLANE)
    private val realtime = RealtimeClient(scope)

    var baseUrl by mutableStateOf(savedOrigin?.url.orEmpty())
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
    var query by mutableStateOf("")
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
    var shell by mutableStateOf(listOf(SHELL_PROMPT))
        private set

    private var active = false
    private var pollJob: Job? = null
    private var toastJob: Job? = null
    private var refreshJob: Job? = null
    private var refreshPending = false
    private var pendingActions = 0
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val refreshLock = Mutex()

    init {
        scope.launch { realtime.state.collect { realtimeState = it } }
        scope.launch {
            realtime.invalidations.collect { signal ->
                if (signal != null && signal.client === session) queueRefresh()
            }
        }
    }

    fun networkAvailable(): Boolean {
        val manager = connectivityManager() ?: return true
        val network = manager.activeNetwork ?: return false
        return manager.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }

    private fun connectivityManager() = context?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

    private fun registerNetworkCallback() {
        val manager = connectivityManager() ?: return
        if (networkCallback != null) return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val source = this
                scope.launch { if (networkCallback === source) retryConnection() }
            }

            override fun onLost(network: Network) {
                val source = this
                scope.launch { if (networkCallback === source) queueRefresh() }
            }
        }
        networkCallback = callback
        if (runCatching { manager.registerDefaultNetworkCallback(callback) }.isFailure) networkCallback = null
    }

    private fun unregisterNetworkCallback() {
        val previous = networkCallback ?: return
        networkCallback = null
        runCatching { connectivityManager()?.unregisterNetworkCallback(previous) }
    }

    /** Explicit selection from diagnostics. Does not persist or carry over the old session. */
    fun applyBaseUrl(url: String) {
        val origin = ConsoleOrigin.parse(url)
        if (origin == null) {
            notify(NO_PLANE)
            return
        }
        if (origin.url != baseUrl) replaceSession(CloudClient(origin))
    }

    /** Legacy diagnostics action: check only the chosen origin, never auto-select another host. */
    suspend fun autoDetect(): String? {
        val selected = session ?: return null
        return selected.origin.url.takeIf { ConsoleDiscovery.ping(it) && session === selected }
    }

    fun editQuery(value: String) {
        query = value
    }

    fun chooseRange(value: String) {
        if (value == range || value !in RANGES) return
        range = value
        queueRefresh()
    }

    fun pushShell(line: String) {
        shell = (shell + line).takeLast(40)
    }

    fun showToast(value: String?) {
        toast = value
    }

    fun notify(message: String) {
        toast = message
        toastJob?.cancel()
        toastJob = scope.launch {
            delay(2_600)
            if (toast == message) toast = null
        }
    }

    private data class RefreshData(val user: User, val snapshot: Snapshot, val analytics: Analytics)

    private suspend fun load(client: CloudClient, requestedRange: String): RefreshData? {
        val me = client.request("auth/me")
        if (me.opt("user") === JSONObject.NULL) return null
        val account = parseUserEnvelope(me)?.takeIf { it.id.isNotBlank() } ?: invalidResponse()
        val overview = client.request("overview")
        if (parseUserEnvelope(overview)?.id != account.id || overview.optJSONArray("projects") == null) invalidResponse()
        val data = client.request("analytics?range=$requestedRange")
        if (data.opt("range") != requestedRange || data.optJSONArray("points") == null || data.opt("total") !is Number) invalidResponse()
        return RefreshData(account, parseSnapshot(overview), parseAnalytics(data))
    }

    private fun publish(client: CloudClient, data: RefreshData) {
        user = data.user
        snapshot = data.snapshot
        analytics = data.analytics.takeIf { it.range == range }
        status = ConsoleStatus.READY
        connection = ConnectionState.CONNECTED
        connectionMethod = "Direct HTTPS"
        error = null
        val timestamp = System.currentTimeMillis()
        lastHealthAt = timestamp
        if (active) {
            realtime.start(client, data.user.id)
            realtime.snapshotRefreshed(client, timestamp)
            if (analytics == null) queueRefresh()
        }
    }

    suspend fun refresh() {
        val selected = session
        if (selected == null || !selected.hasSession()) {
            if (user != null && selected != null) loseSession(selected)
            else if (status == ConsoleStatus.LOADING) {
                status = ConsoleStatus.ANON
                connection = ConnectionState.AUTH_REQUIRED
            }
            return
        }
        refresh(selected)
    }

    private suspend fun refresh(selected: CloudClient) = refreshLock.withLock {
        if (session !== selected) return@withLock
        try {
            val data = load(selected, range)
            if (session !== selected) return@withLock
            if (data == null || (user != null && user?.id != data.user.id)) loseSession(selected)
            else publish(selected, data)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            if (session !== selected) return@withLock
            if (failure is CloudException && failure.status == 401) {
                loseSession(selected)
            } else {
                // Keep the last good data and keep safety polls running on transient errors.
                status = if (snapshot == null) ConsoleStatus.ERROR else ConsoleStatus.READY
                connection = when {
                    failure is UnknownHostException || failure is SSLException -> ConnectionState.INVALID_ENDPOINT
                    !networkAvailable() -> ConnectionState.NETWORK_UNAVAILABLE
                    else -> ConnectionState.SERVER_UNAVAILABLE
                }
                error = safeError(failure, "Could not refresh the console. Showing the last successful snapshot.")
            }
        }
    }

    private fun loseSession(selected: CloudClient) {
        replaceSession(CloudClient(selected.origin))
        error = "This console session ended. Sign in again."
    }

    private fun queueRefresh() {
        if (!active) return
        refreshPending = true
        if (refreshJob?.isActive == true) return
        refreshJob = scope.launch {
            while (refreshPending && isActive) {
                delay(250)
                refreshPending = false
                refresh()
            }
        }
    }

    private fun replaceSession(replacement: CloudClient?) {
        authAttempt?.close()
        authAttempt = null
        session?.close()
        session = replacement
        baseUrl = replacement?.origin?.url.orEmpty()
        realtime.stop()
        realtimeState = realtime.state.value
        refreshPending = false
        refreshJob?.cancel()
        refreshJob = null
        user = null
        snapshot = null
        analytics = null
        query = ""
        shell = listOf(SHELL_PROMPT)
        toastJob?.cancel()
        toast = null
        lastHealthAt = null
        connectionMethod = null
        error = null
        pendingActions = 0
        busy = false
        status = ConsoleStatus.ANON
        connection = ConnectionState.AUTH_REQUIRED
    }

    /** A mutation and any follow-up reads stay on the captured session; no automatic retry. */
    suspend fun call(path: String, body: JSONObject? = null, method: String = "POST"): JSONObject {
        val selected = client
        if (user == null || !selected.hasSession()) {
            if (user != null) loseSession(selected)
            throw CloudException("Sign in required.", 401)
        }
        busy = true
        pendingActions += 1
        try {
            val result = selected.request(path, method, body?.toString())
            if (session !== selected) throw CloudException("This console connection changed.")
            refresh(selected)
            if (session !== selected) throw CloudException("This console connection changed.")
            return result
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            if (session === selected && failure is CloudException && failure.status == 401) loseSession(selected)
            throw CloudException(safeError(failure, "Could not confirm the request. Check its result before retrying."))
        } finally {
            if (session === selected) {
                pendingActions -= 1
                busy = pendingActions > 0
            }
        }
    }

    internal suspend fun login(origin: ConsoleOrigin, email: String, password: String) {
        authenticate(origin) { candidate ->
            if (!ConsoleDiscovery.isConsole(candidate.health())) throw CloudException("The address did not identify as a supported MobileCloud API.")
            val body = JSONObject().put("email", email).put("password", password)
            val reply = candidate.request("auth/login", "POST", body.toString())
            val account = parseUserEnvelope(reply)?.takeIf { it.id.isNotBlank() } ?: invalidResponse()
            Unit to account.id
        }
    }

    /** Stage password sign-in or QR claim in isolation; switch/persist only after verified REST refresh. */
    internal suspend fun <T> authenticate(
        origin: ConsoleOrigin,
        handshake: suspend (CloudClient) -> Pair<T, String>,
    ): T {
        if (authAttempt != null) throw CloudException("Another sign-in is already in progress.")
        val candidate = CloudClient(origin)
        authAttempt = candidate
        var installed = false
        try {
            val (result, expectedAccount) = handshake(candidate)
            if (!candidate.hasSession()) throw CloudException("The console did not establish a session.")
            val data = load(candidate, range)
            if (data == null || data.user.id != expectedAccount) throw CloudException("The console session could not be verified.")
            currentCoroutineContext().ensureActive()
            if (authAttempt !== candidate) throw CloudException("This console connection changed.")
            authAttempt = null
            replaceSession(candidate)
            installed = true
            prefs?.edit()?.putString(KEY_URL, candidate.origin.url)?.apply()
            publish(candidate, data)
            return result
        } finally {
            if (authAttempt === candidate) authAttempt = null
            if (!installed) candidate.close()
        }
    }

    fun logout() {
        val selected = session ?: return
        val logoutClient = selected.takeForLogout()
        val signedOut = CloudClient(selected.origin)
        replaceSession(signedOut)
        // Owned by the store, not the UI page being removed on logout.
        scope.launch {
            try {
                logoutClient.request("auth/logout", "POST")
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (session === signedOut) error = "Signed out on this phone. Server sign-out could not be confirmed."
            } finally {
                logoutClient.close()
            }
        }
    }

    fun retryConnection() {
        if (!active) return
        realtime.stop()
        queueRefresh()
    }

    fun start() {
        if (active) return
        active = true
        queueRefresh()
        registerNetworkCallback()
        pollJob = scope.launch {
            while (isActive) {
                delay(60_000)
                if (user != null) queueRefresh()
            }
        }
    }

    fun pause() {
        active = false
        pollJob?.cancel()
        pollJob = null
        refreshJob?.cancel()
        refreshJob = null
        refreshPending = false
        unregisterNetworkCallback()
        realtime.stop()
    }

    fun stop() {
        pause()
        authAttempt?.close()
        authAttempt = null
        session?.close()
    }

    companion object {
        private const val KEY_URL = "console_base_url"
        private const val SHELL_PROMPT = "CloudShell reads this server. Type help."
        private val RANGES = setOf("1h", "24h", "7d", "30d")
        const val NO_PLANE = "Enter the console's HTTPS origin, such as https://console.example.com."

        private fun invalidResponse(): Nothing = throw CloudException("The console returned an invalid response.")

        internal fun safeError(failure: Exception, fallback: String): String = when (failure) {
            is CloudException -> failure.message ?: fallback
            is SSLException -> "Could not verify the connection. Check the HTTPS address and certificate."
            is UnknownHostException -> "The console hostname could not be found."
            else -> fallback
        }
    }
}
