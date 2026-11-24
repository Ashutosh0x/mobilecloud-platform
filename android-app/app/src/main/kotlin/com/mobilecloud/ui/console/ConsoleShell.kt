package com.mobilecloud.ui.console

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.R
import com.mobilecloud.console.ConsoleStore
import com.mobilecloud.console.ConnectionState
import com.mobilecloud.console.RealtimeStatus
import com.mobilecloud.ui.theme.AppFonts
import com.mobilecloud.ui.theme.Aurora
import com.mobilecloud.ui.screens.CloudShellScreen
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/* =========================================================================
 * CONSOLE SHELL — port of `components/Shell.tsx`:
 * topbar (collapse/brand/search/online/bell/account), grouped sidebar drawer,
 * ≤800px bottom-nav (Project group + More), jump-to palette, console-password
 * gate and toast.
 * ========================================================================= */

@Composable
fun LoadingSplash() {
    Box(Modifier.fillMaxSize().background(Aurora.Bg), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            LogoMark(40.dp)
            Spacer(Modifier.height(16.dp))
            Text("Loading console…", color = Aurora.TextMid, fontSize = 12.sp)
        }
    }
}

@Composable
internal fun LogoMark(size: Dp) {
    Icon(
        painter = painterResource(R.drawable.ic_launcher_foreground),
        contentDescription = null,
        modifier = Modifier.size(size).background(colorResource(R.color.ic_launcher_background), RoundedCornerShape(size / 4)),
        tint = Color.Unspecified,
    )
}

/** Full console shell once the account is loaded. */
@Composable
fun ConsoleShell(store: ConsoleStore) {
    var route by remember { mutableStateOf("/") }
    var drawer by remember { mutableStateOf(false) }
    var jump by remember { mutableStateOf(false) }
    var notes by remember { mutableStateOf(false) }
    var account by remember { mutableStateOf(false) }
    var diagnostics by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val snap = store.snapshot
    val unread = snap?.notifications?.count { !it.read } ?: 0

    // The chip reflects the connection *state machine*, not a guess: it never
    // reads "Connected" until an authenticated session has actually answered.
    val live = store.connection == ConnectionState.CONNECTED
    val chipLabel = if (live) store.realtimeState.label else connectionLabel(store.connection)
    val chipTone = if (live) {
        if (store.realtimeState.status == RealtimeStatus.CONNECTED) Aurora.GlowGreen else Aurora.Amber
    } else {
        connectionTone(store.connection)
    }

    Box(Modifier.fillMaxSize().background(Aurora.Bg)) {
        Column(Modifier.fillMaxSize()) {
            TopBar(
                label = chipLabel,
                tone = chipTone,
                onStatus = { diagnostics = !diagnostics; notes = false; account = false },
                unread = unread,
                onMenu = { drawer = true },
                onSearch = { jump = true },
                onBell = { notes = !notes; account = false; diagnostics = false },
                onAccount = { account = !account; notes = false; diagnostics = false },
            )

            val protection = snap?.protection
            val needsUnlock = protection != null && protection.required && !protection.unlocked

            // The terminal is a viewport, not a document: giving it the
            // vertical-scroll parent used by every other page collapses the
            // canvas to zero height. It gets the whole content slot instead.
            if (route == "/shell" && !needsUnlock) {
                CloudShellScreen(modifier = Modifier.weight(1f).fillMaxWidth())
            } else {
                Column(
                    Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 14.dp)
                        .padding(top = 6.dp, bottom = 96.dp),
                ) {
                    Text(navLabel(route), color = Aurora.TextLow, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp)
                    Spacer(Modifier.height(10.dp))

                    val degraded = !live || store.realtimeState.status == RealtimeStatus.SYNC_ERROR
                    if (degraded) {
                        ConnectionBanner(store, onDetails = { diagnostics = true })
                        Spacer(Modifier.height(12.dp))
                    }

                    if (protection != null && protection.required && !protection.unlocked) {
                        ProtectGate(
                            onSubmit = { password ->
                                scope.launch {
                                    runCatching { store.call("protection/unlock", org.json.JSONObject().put("password", password)) }
                                        .onSuccess { store.notify("Console unlocked") }
                                        .onFailure { store.notify(it.message ?: "Password does not match") }
                                }
                            },
                        )
                    } else {
                        ConsoleRoutes(store, route, onNavigate = { route = it })
                    }
                }
            }
        }

        BottomNav(
            route = route,
            onSelect = { route = it },
            onMore = { drawer = true },
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(horizontal = 10.dp)
                .padding(bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + 6.dp),
        )

        // ---- Sidebar drawer overlay ----
        if (drawer) {
            Box(
                Modifier.fillMaxSize().background(Color(0xCC000000))
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { drawer = false },
            )
            AnimatedVisibility(
                visible = true,
                enter = slideInHorizontally(tween(220)) { -it } + fadeIn(tween(160)),
                exit = slideOutHorizontally(tween(180)) { -it },
            ) {
                Sidebar(
                    route = route,
                    unpadded = { drawer = false },
                    onNavigate = { drawer = false; route = it },
                    store = store,
                )
            }
        }

        // ---- Notifications / account dropdowns ----
        if (notes) {
            Dropdown(
                modifier = Modifier.align(Alignment.TopEnd).padding(top = 54.dp, end = 10.dp),
            ) {
                Text(
                    if (unread > 0) "$unread unread" else "Notifications",
                    color = Aurora.TextMid, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                )
                val items = snap?.notifications?.take(8) ?: emptyList()
                if (items.isEmpty()) {
                    CEmpty("No notifications yet.")
                } else {
                    items.forEach { n ->
                        Box(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).clickable {
                                notes = false
                                scope.launch { runCatching { store.call("notifications/${n.id}", null, "PATCH") } }
                            }.padding(vertical = 8.dp, horizontal = 6.dp),
                        ) {
                            Text(
                                n.title + if (n.read) "" else " · unread",
                                color = Aurora.TextHi, fontSize = 12.sp, maxLines = 1,
                            )
                        }
                    }
                }
            }
        }

        if (account && snap?.user != null) {
            Dropdown(modifier = Modifier.align(Alignment.TopEnd).padding(top = 54.dp, end = 10.dp)) {
                Text("${snap.user.name} · ${snap.user.role}", color = Aurora.TextMid, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                MenuItem("Settings") { account = false; route = "/settings" }
                MenuItem("Plan · ${snap.billing?.plan ?: "—"}") { account = false; route = "/billing" }
                MenuItem("Sign out", danger = true) {
                    account = false
                    scope.launch { store.logout() }
                }
            }
        }

        if (diagnostics) {
            ConnectionPanel(
                store = store,
                onDismiss = { diagnostics = false },
                modifier = Modifier.align(Alignment.TopEnd).padding(top = 54.dp, end = 10.dp),
            )
        }

        if (jump) {
            JumpModal(
                store = store,
                onDismiss = { jump = false },
                onGo = { jump = false; route = it },
            )
        }

        AnimatedVisibility(
            visible = store.toast != null,
            enter = fadeIn(tween(180)) + slideInVertically(tween(200)) { it / 3 },
            exit = fadeOut(tween(160)),
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 108.dp),
        ) {
            ToastBox(store.toast ?: "")
        }
    }
}

/* ------------------------------- TopBar -------------------------------- */

@Composable
private fun TopBar(
    label: String,
    tone: Color,
    onStatus: () -> Unit,
    unread: Int,
    onMenu: () -> Unit,
    onSearch: () -> Unit,
    onBell: () -> Unit,
    onAccount: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(Aurora.Bg)
            .padding(top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding())
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconBare(Icons.Filled.Menu, "Open navigation", onMenu)
        Spacer(Modifier.width(6.dp))
        LogoMark(30.dp)
        Spacer(Modifier.width(9.dp))
        Column(Modifier.weight(1f)) {
            Text("MobileCloud", color = Aurora.TextHi, fontSize = 15.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.3).sp)
            Text("Build. Ship. Scale.", color = Aurora.TextMid, fontSize = 10.sp)
        }
        IconBare(Icons.Filled.Search, "Search", onSearch)
        Spacer(Modifier.width(4.dp))
        Box {
            IconBare(Icons.Filled.Notifications, if (unread == 0) "Notifications" else "Notifications, $unread unread", onBell)
            if (unread > 0) {
                Box(Modifier.align(Alignment.TopEnd).size(7.dp).background(Aurora.Red, CircleShape))
            }
        }
        Spacer(Modifier.width(6.dp))
        // Realtime / connection indicator — tapping it opens the diagnostics panel.
        Row(
            Modifier.clip(RoundedCornerShape(999.dp)).border(1.dp, Aurora.Border, RoundedCornerShape(999.dp))
                .clickable { onStatus() }.padding(horizontal = 9.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(7.dp).background(tone, CircleShape))
            Spacer(Modifier.width(6.dp))
            Text(label, color = tone, fontSize = 10.sp, maxLines = 1)
        }
        Spacer(Modifier.width(6.dp))
        Row(
            Modifier.clip(RoundedCornerShape(999.dp)).border(1.dp, Aurora.Border, RoundedCornerShape(999.dp))
                .clickable { onAccount() }.padding(horizontal = 8.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Person, contentDescription = "Account", tint = Aurora.TextMid, modifier = Modifier.size(15.dp))
        }
    }
}

@Composable
private fun IconBare(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(48.dp)
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, Aurora.Border, RoundedCornerShape(8.dp))
            .clickable { onClick() },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = Aurora.TextHi, modifier = Modifier.size(17.dp))
    }
}

/* ------------------------------- Sidebar ------------------------------- */

@Composable
private fun Sidebar(
    route: String,
    unpadded: () -> Unit,
    onNavigate: (String) -> Unit,
    store: ConsoleStore,
) {
    Column(
        Modifier
            .width(268.dp)
            .fillMaxHeight()
            .background(Aurora.Card)
            .border(1.dp, Aurora.Border, RoundedCornerShape(topEnd = 14.dp, bottomEnd = 14.dp))
            .padding(top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding())
            .verticalScroll(rememberScrollState())
            .padding(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            LogoMark(28.dp)
            Spacer(Modifier.width(9.dp))
            Text("Console", color = Aurora.TextHi, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            IconBare(Icons.Filled.Close, "Close navigation") { unpadded() }
        }
        Spacer(Modifier.height(12.dp))
        ConsoleGroups.forEach { group ->
            Text(
                group.label.uppercase(),
                color = Aurora.TextLow, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp,
                modifier = Modifier.padding(start = 6.dp, top = 12.dp, bottom = 6.dp),
            )
            group.items.forEach { item ->
                val on = item.href == route
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (on) Color(0x220070F3) else Color.Transparent)
                        .clickable { onNavigate(item.href) }
                        .padding(horizontal = 8.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(item.icon, contentDescription = null, tint = if (on) Aurora.Cyan else Aurora.TextMid, modifier = Modifier.size(17.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(item.label, color = if (on) Aurora.Cyan else Aurora.TextHi, fontSize = 13.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal)
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        Box(Modifier.fillMaxWidth().height(1.dp).background(Aurora.Divider))
        Spacer(Modifier.height(12.dp))
        Text("Control plane", color = Aurora.TextHi, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Text(
            store.baseUrl.ifBlank { "Not configured" },
            color = Aurora.TextLow, fontSize = 11.sp, fontFamily = AppFonts.Mono, maxLines = 1,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            "${connectionLabel(store.connection)} · ${store.realtimeState.label}",
            color = Aurora.TextLow, fontSize = 11.sp, maxLines = 1,
        )
        store.connectionMethod?.let {
            Spacer(Modifier.height(4.dp))
            Text(it, color = Aurora.TextLow, fontSize = 11.sp, maxLines = 1)
        }
        Spacer(Modifier.height(4.dp))
        Text(
            store.snapshot?.metrics?.let { "Up ${it.processUptimeSec / 60}m" } ?: "No metrics yet",
            color = Aurora.TextLow, fontSize = 11.sp, fontFamily = AppFonts.Mono,
        )
        Spacer(Modifier.height(12.dp))
    }
}

/* ------------------------------ Bottom nav ----------------------------- */

@Composable
private fun BottomNav(route: String, onSelect: (String) -> Unit, onMore: () -> Unit, modifier: Modifier = Modifier) {
    val items = ConsoleGroups.first().items
    val shape = RoundedCornerShape(14.dp)
    Row(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Aurora.Card.copy(alpha = 0.98f))
            .border(1.dp, Aurora.Border, shape)
            .padding(horizontal = 6.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items.forEach { item ->
            val on = item.href == route
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(8.dp))
                    .clickable { onSelect(item.href) }
                    .padding(vertical = 2.dp),
            ) {
                Box(
                    Modifier
                        .then(if (on) Modifier.background(Color(0x220070F3), RoundedCornerShape(8.dp)).border(1.dp, Color(0x660070F3), RoundedCornerShape(8.dp)) else Modifier)
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                ) {
                    Icon(item.icon, contentDescription = item.label, tint = if (on) Aurora.Cyan else Aurora.TextMid, modifier = Modifier.size(18.dp))
                }
                Spacer(Modifier.height(2.dp))
                Text(
                    if (item.label == "Overview") "Home" else item.label.split(" ").first(),
                    color = if (on) Aurora.Cyan else Aurora.TextMid,
                    fontSize = 10.sp, maxLines = 1,
                    fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                )
            }
        }
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.weight(1f).clip(RoundedCornerShape(8.dp)).clickable { onMore() }.padding(vertical = 2.dp),
        ) {
            Box(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                Icon(Icons.Filled.GridView, contentDescription = "More", tint = Aurora.TextMid, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.height(2.dp))
            Text("More", color = Aurora.TextMid, fontSize = 10.sp, maxLines = 1)
        }
    }
}

/* -------------------------- Dropdowns / modal -------------------------- */

@Composable
private fun Dropdown(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(
        modifier
            .width(230.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Aurora.CardAlt)
            .border(1.dp, Aurora.Border, RoundedCornerShape(12.dp))
            .padding(10.dp),
    ) { content() }
}

@Composable
private fun MenuItem(text: String, danger: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).clickable { onClick() }.padding(vertical = 9.dp, horizontal = 6.dp),
    ) {
        Text(text, color = if (danger) Aurora.Red else Aurora.TextHi, fontSize = 13.sp)
    }
}

@Composable
private fun ToastBox(text: String) {
    Box(
        Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(Aurora.CardAlt)
            .border(1.dp, Aurora.Border, RoundedCornerShape(10.dp))
            .padding(horizontal = 16.dp, vertical = 11.dp),
    ) {
        Text(text, color = Aurora.TextHi, fontSize = 13.sp)
    }
}

@Composable
private fun JumpModal(store: ConsoleStore, onDismiss: () -> Unit, onGo: (String) -> Unit) {
    var palette by remember { mutableStateOf(store.query) }
    val q = palette.lowercase()
    val pageHits = ConsolePages.filter { it.label.lowercase().contains(q) }
    val projectHits = (store.snapshot?.projects ?: emptyList())
        .filter { it.name.lowercase().contains(q) }
        .map { NavItem("/projects", it.name, it.let { _ -> Icons.Filled.GridView }) }
    val hits = (pageHits + projectHits).take(8)

    Box(
        Modifier.fillMaxSize().background(Color(0xCC000000))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onDismiss() },
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            Modifier
                .padding(top = 90.dp)
                .padding(horizontal = 18.dp)
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(Aurora.CardAlt)
                .border(1.dp, Aurora.Border, RoundedCornerShape(14.dp))
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {}
                .padding(14.dp),
        ) {
            Text("Jump to", color = Aurora.TextHi, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(10.dp))
            CField(label = "", value = palette, onValueChange = { palette = it; store.editQuery(it) }, placeholder = "Pages and projects")
            Spacer(Modifier.height(8.dp))
            if (hits.isEmpty()) {
                CEmpty("Nothing matches.")
            } else {
                hits.forEach { hit ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { store.editQuery(""); onGo(hit.href) }.padding(vertical = 10.dp, horizontal = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(hit.icon, contentDescription = null, tint = Aurora.TextMid, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(10.dp))
                        Text(hit.label, color = Aurora.TextHi, fontSize = 13.sp)
                    }
                }
            }
        }
    }
}

/* ------------------------------ Protections ---------------------------- */

@Composable
private fun ProtectGate(onSubmit: (String) -> Unit) {
    var password by remember { mutableStateOf("") }
    CPanel(title = "Console password", subtitle = "This device has not unlocked the password stored for this account.") {
        CField(label = "Password", value = password, onValueChange = { password = it }, password = true)
        Spacer(Modifier.height(12.dp))
        CButton("Unlock", onClick = { onSubmit(password) })
    }
}

/* =========================================================================
 * CONNECTION DIAGNOSTICS
 * The chip and the sidebar say *what* is happening; these say *why*, in terms
 * the user can act on. A 401 is never reported as a network failure, and a
 * "Connected" label is only ever shown after an authenticated session answered.
 * ========================================================================= */

private fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.INITIALIZING -> "Starting"
    ConnectionState.DISCOVERING -> "Finding server"
    ConnectionState.CONNECTED -> "Connected"
    ConnectionState.AUTH_REQUIRED -> "Sign in"
    ConnectionState.NETWORK_UNAVAILABLE -> "No network"
    ConnectionState.SERVER_UNAVAILABLE -> "Server unreachable"
    ConnectionState.INVALID_ENDPOINT -> "Invalid server"
    ConnectionState.AUTHENTICATION_FAILED -> "Auth failed"
}

private fun connectionTone(state: ConnectionState): Color = when (state) {
    ConnectionState.CONNECTED -> Aurora.GlowGreen
    ConnectionState.INITIALIZING, ConnectionState.DISCOVERING -> Aurora.Amber
    else -> Aurora.Red
}

/**
 * Explains why the console is not live, separating the cases the user can act
 * on: no network at all, a network that cannot reach the server, a server that
 * is down or firewalled, and an address that is not a MobileCloud API.
 */
private fun connectionAdvice(state: ConnectionState, store: ConsoleStore): String = when (state) {
    ConnectionState.INITIALIZING -> "Checking the control plane…"
    ConnectionState.DISCOVERING ->
        "Searching the networks this device can reach (USB, LAN, VPN) for a MobileCloud server."
    ConnectionState.CONNECTED -> "Reachable and authenticated."
    ConnectionState.AUTH_REQUIRED -> "The server answered. Sign in to load this account."
    ConnectionState.NETWORK_UNAVAILABLE ->
        "This device has no working network. Turn on Wi-Fi or mobile data — and your VPN, if the server is behind one."
    ConnectionState.SERVER_UNAVAILABLE ->
        "The phone is online but nothing answered at ${store.baseUrl.ifBlank { "the saved address" }}. " +
            "Start the dashboard on the PC (npm run dev --port 3210), allow port 3210 through Windows Firewall, " +
            "or pick Change server."
    ConnectionState.INVALID_ENDPOINT ->
        "No MobileCloud API answered there. The address is wrong or another service owns that port. " +
            "Plug in USB and retry, or pick Change server."
    ConnectionState.AUTHENTICATION_FAILED -> "The server rejected the request. Sign in again."
}

private val CLOCK = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

private fun clock(ts: Long?): String = ts?.let { CLOCK.format(Date(it)) } ?: "—"

@Composable
private fun ConnectionBanner(store: ConsoleStore, onDetails: () -> Unit) {
    val connected = store.connection == ConnectionState.CONNECTED
    val syncError = store.realtimeState.status == RealtimeStatus.SYNC_ERROR
    val tone = when {
        connected && syncError -> Aurora.Red
        connected -> Aurora.Amber
        else -> connectionTone(store.connection)
    }
    val label = if (connected) store.realtimeState.label else connectionLabel(store.connection)
    val message = if (connected) {
        store.realtimeState.lastError ?: "Realtime updates are paused; the console is catching up by polling."
    } else {
        connectionAdvice(store.connection, store)
    }

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(tone.copy(alpha = 0.10f))
            .border(1.dp, tone.copy(alpha = 0.30f), RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(7.dp).background(tone, CircleShape))
            Spacer(Modifier.width(7.dp))
            Text(label, color = tone, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(
                "Details",
                color = Aurora.TextHi, fontSize = 11.sp,
                modifier = Modifier.clickable { onDetails() }.padding(4.dp),
            )
        }
        Spacer(Modifier.height(6.dp))
        Text(message, color = Aurora.TextMid, fontSize = 11.sp)
        store.error?.takeIf { !connected }?.let {
            Spacer(Modifier.height(4.dp))
            Text(it, color = Aurora.TextLow, fontSize = 11.sp, fontFamily = AppFonts.Mono, maxLines = 2)
        }
    }
}

/** Full diagnostics card: status, endpoint, method, timings, retry, change server. */
@Composable
private fun ConnectionPanel(
    store: ConsoleStore,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val rt = store.realtimeState
    val scope = rememberCoroutineScope()
    var manual by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf(store.baseUrl) }

    Column(
        modifier
            .width(282.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Aurora.CardAlt)
            .border(1.dp, Aurora.Border, RoundedCornerShape(12.dp))
            .verticalScroll(rememberScrollState())
            .padding(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Connection", color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text("Close", color = Aurora.TextMid, fontSize = 11.sp, modifier = Modifier.clickable { onDismiss() }.padding(4.dp))
        }
        Spacer(Modifier.height(6.dp))

        CListRow("Status", connectionLabel(store.connection), valueColor = connectionTone(store.connection), mono = false)
        CHairline()
        CListRow(
            "Realtime", rt.label,
            valueColor = if (rt.status == RealtimeStatus.CONNECTED) Aurora.GlowGreen else Aurora.Amber,
            mono = false,
        )
        CHairline()
        CListRow("Transport", rt.via ?: if (rt.status == RealtimeStatus.CONNECTED) "websocket" else "—")
        CHairline()
        CListRow("Endpoint", store.baseUrl.ifBlank { "not set" })
        CHairline()
        CListRow("Method", store.connectionMethod ?: "—", mono = false)
        CHairline()
        CListRow("Account", store.user?.name ?: store.user?.email ?: "—", mono = false)
        CHairline()
        CListRow("Device", "${Build.MANUFACTURER} ${Build.MODEL}", mono = false)
        CHairline()
        CListRow("Last health check", clock(store.lastHealthAt))
        CHairline()
        CListRow("Last sync", clock(rt.lastSyncAt))
        CHairline()
        CListRow("Cursor", rt.cursor.toString())
        CHairline()
        CListRow("Pending changes", rt.pending.toString())
        CHairline()
        CListRow(
            "Last error", rt.lastError ?: store.error ?: "—",
            valueColor = if (rt.lastError != null || store.error != null) Aurora.Red else Aurora.TextHi,
            mono = false,
        )

        Spacer(Modifier.height(10.dp))
        Text(connectionAdvice(store.connection, store), color = Aurora.TextMid, fontSize = 11.sp)

        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            CButton("Retry", onClick = { store.retryConnection(); store.notify("Reconnecting…") }, compact = true)
            CButton("Change server", onClick = { manual = !manual }, kind = BtnKind.GHOST, compact = true)
        }
        Spacer(Modifier.height(6.dp))
        CButton(
            "Auto-detect",
            onClick = {
                store.notify("Searching for the control plane…")
                scope.launch {
                    if (store.autoDetect() == null) store.notify(ConsoleStore.NO_PLANE) else store.retryConnection()
                }
            },
            kind = BtnKind.GHOST,
            compact = true,
        )

        if (manual) {
            Spacer(Modifier.height(10.dp))
            CField("Server address", draft, { draft = it }, placeholder = "http://192.168.0.104:3210", mono = true)
            Spacer(Modifier.height(8.dp))
            CButton(
                "Use this server",
                onClick = {
                    store.applyBaseUrl(draft)
                    draft = store.baseUrl
                    store.notify("Connecting to ${store.baseUrl}…")
                    store.retryConnection()
                },
                compact = true,
            )
        }
    }
}
