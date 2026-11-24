package com.mobilecloud.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.mobilecloud.MobileCloudApp
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Dual-path transport monitor (Wi-Fi + cellular).
 *
 * Requests both transports simultaneously — Android allows only one transport
 * per [NetworkRequest], so Wi-Fi and cellular get distinct requests and
 * distinct callbacks. Each transport keeps its own live [Network] reference,
 * so when the serving path is lost the other path's already-registered callback
 * is used to fail over immediately (no null window, no re-request round trip).
 *
 * This service only observes and selects the serving [Network]; it does not
 * create tunnels, and it reports no invented latency figure — Android exposes
 * no per-network RTT to apps, so none is shown.
 */
class NetworkBunderService : Service() {

    private val wifiNetwork = AtomicReference<Network?>(null)
    private val cellularNetwork = AtomicReference<Network?>(null)
    private val wifiValidated = AtomicBoolean(false)
    private val cellularValidated = AtomicBoolean(false)

    private lateinit var connectivity: ConnectivityManager
    private var wifiCallback: ConnectivityManager.NetworkCallback? = null
    private var cellularCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startAsForeground()
        connectivity = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        requestDualWan()
    }

    private fun startAsForeground() {
        startForeground(
            NOTIFICATION_ID,
            NotificationCompat.Builder(this, MobileCloudApp.CHANNEL_ID)
                .setContentTitle("Network path monitor active")
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .build()
        )
    }

    private fun requestDualWan() {
        // Wi-Fi first: validated, low-latency bias.
        val wifi = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                wifiNetwork.set(network)
                android.util.Log.i(TAG, "Wi-Fi path available: $network")
            }

            override fun onLost(network: Network) {
                wifiNetwork.compareAndSet(network, null)
                wifiValidated.set(false)
                android.util.Log.w(TAG, "Wi-Fi lost — serving path fails over to ${servingNetwork()}")
            }

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                wifiValidated.set(caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
            }
        }
        wifiCallback = wifi
        register(
            NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)
                .build(),
            wifi,
        )

        // Cellular second: standing validation (the hot spare).
        val cellular = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                cellularNetwork.set(network)
                android.util.Log.i(TAG, "Cellular path available: $network")
            }

            override fun onLost(network: Network) {
                cellularNetwork.compareAndSet(network, null)
                cellularValidated.set(false)
                android.util.Log.w(TAG, "Cellular lost — serving path is ${servingNetwork()}")
            }

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                cellularValidated.set(caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
            }
        }
        cellularCallback = cellular
        register(
            NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build(),
            cellular,
        )
    }

    private fun register(request: NetworkRequest, callback: ConnectivityManager.NetworkCallback) {
        runCatching { connectivity.requestNetwork(request, callback) }
            .onFailure { android.util.Log.w(TAG, "could not register dual-WAN callback", it) }
    }

    /**
     * The network the caller should prefer: a validated Wi-Fi path, else a
     * validated cellular path, else whichever transport is merely available,
     * else the system's current default. Non-null whenever any transport is
     * usable — it never strands callers on a stale null pointer.
     */
    fun servingNetwork(): Network? {
        val wifi = wifiNetwork.get()
        val cellular = cellularNetwork.get()
        return when {
            wifi != null && wifiValidated.get() -> wifi
            cellular != null && cellularValidated.get() -> cellular
            wifi != null -> wifi
            cellular != null -> cellular
            else -> runCatching { connectivity.activeNetwork }.getOrNull()
        }
    }

    override fun onDestroy() {
        wifiCallback?.let { runCatching { connectivity.unregisterNetworkCallback(it) } }
        cellularCallback?.let { runCatching { connectivity.unregisterNetworkCallback(it) } }
        wifiCallback = null
        cellularCallback = null
        wifiNetwork.set(null)
        cellularNetwork.set(null)
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        private const val TAG = "NetworkBunder"
        const val NOTIFICATION_ID = 1002

        fun start(context: Context) {
            context.startForegroundService(Intent(context, NetworkBunderService::class.java))
        }
    }
}
