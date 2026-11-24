package com.mobilecloud.ui.console.pages

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.console.ConsoleStore
import com.mobilecloud.ui.console.BtnKind
import com.mobilecloud.ui.console.CBadge
import com.mobilecloud.ui.console.CButton
import com.mobilecloud.ui.console.CEmpty
import com.mobilecloud.ui.console.CField
import com.mobilecloud.ui.console.CPanel
import com.mobilecloud.ui.console.CSelect
import com.mobilecloud.ui.console.CStat
import com.mobilecloud.ui.console.CToggleRow
import com.mobilecloud.ui.console.Hint
import com.mobilecloud.ui.console.HourBars
import com.mobilecloud.ui.console.PageHead
import com.mobilecloud.ui.console.Tone
import com.mobilecloud.ui.console.action
import com.mobilecloud.ui.console.ctime
import com.mobilecloud.ui.console.jobj
import com.mobilecloud.ui.theme.AppFonts
import com.mobilecloud.ui.theme.Aurora
import kotlinx.coroutines.launch

/* ------------------------------- Firewall ------------------------------ */

@Composable
fun FirewallPage(store: ConsoleStore) {
    val snap = store.snapshot ?: return
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var action by remember { mutableStateOf("log") }
    var matchKey by remember { mutableStateOf("path") }
    var matchOp by remember { mutableStateOf("starts_with") }
    var matchValue by remember { mutableStateOf("/functions") }
    var headerName by remember { mutableStateOf("") }

    PageHead(
        "Firewall",
        "Rules apply to this API for your account. Account, overview, and firewall routes stay reachable so a rule cannot lock you out. " +
            "A JA4 rule matches only when the request sends an x-ja4-fingerprint header.",
    )
    Spacer(Modifier.height(12.dp))
    CPanel(title = "New rule") {
        CField("Rule name", name, { name = it }, placeholder = "Name")
        Spacer(Modifier.height(8.dp))
        CSelect(
            listOf("log", "deny", "rate_limit"), action, { action = it },
            modifier = Modifier.fillMaxWidth(),
            label = { if (it == "rate_limit") "rate limit 30 / 60s" else it },
        )
        Spacer(Modifier.height(8.dp))
        CSelect(
            listOf("path", "ip", "header", "ja4", "user_agent", "host"), matchKey, { matchKey = it },
            modifier = Modifier.fillMaxWidth(),
            label = { if (it == "ja4") "ja4 header" else if (it == "user_agent") "user agent" else it },
        )
        Spacer(Modifier.height(8.dp))
        CSelect(
            listOf("starts_with", "equals", "contains"), matchOp, { matchOp = it },
            modifier = Modifier.fillMaxWidth(),
            label = { it.replace("_", " ") },
        )
        Spacer(Modifier.height(8.dp))
        CField("Value", matchValue, { matchValue = it })
        if (matchKey == "header") {
            Spacer(Modifier.height(8.dp))
            CField("Header name", headerName, { headerName = it }, placeholder = "header name")
        }
        Spacer(Modifier.height(10.dp))
        CButton("Save rule", onClick = {
            store.action(scope, "Rule saved") {
                store.call(
                    "firewall",
                    jobj(
                        "name" to name, "action" to action, "matchKey" to matchKey, "matchOp" to matchOp,
                        "matchValue" to matchValue, "headerName" to headerName, "limitCount" to 30, "windowSec" to 60,
                    ),
                )
            }
            name = ""
        }, enabled = name.isNotBlank() && matchValue.isNotBlank())
    }

    Spacer(Modifier.height(14.dp))
    CPanel {
        if (snap.firewall.rules.isEmpty()) {
            CEmpty("No firewall rules stored.")
        } else {
            snap.firewall.rules.forEach { rule ->
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(rule.name, color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Text("${rule.action} when ${rule.matchKey} ${rule.matchOp} ${rule.matchValue}", color = Aurora.TextMid, fontSize = 11.sp)
                    }
                    CButton("Remove", onClick = {
                        store.action(scope, "Rule removed") { store.call("firewall/${rule.id}", null, "DELETE") }
                    }, kind = BtnKind.DANGER, compact = true)
                }
            }
        }
    }

    Spacer(Modifier.height(14.dp))
    CPanel(title = "Recent matches") {
        if (snap.firewall.events.isEmpty()) {
            CEmpty("No rule has matched a request yet.")
        } else {
            snap.firewall.events.forEach { event ->
                Column(Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
                    Text("${event.action} ${event.path}", color = Aurora.TextHi, fontSize = 12.sp)
                    Text("${event.ip} · ${ctime(event.at)}", color = Aurora.TextMid, fontSize = 11.sp)
                }
            }
        }
    }

    Spacer(Modifier.height(14.dp))
    TrafficPanel(store)
}

@Composable
private fun TrafficPanel(store: ConsoleStore) {
    val traffic = store.snapshot?.firewall?.traffic
    if (traffic == null) {
        CEmpty("No traffic summary yet.")
        return
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.weight(1f)) { CStat("API calls, 24h", traffic.requests.toString()) }
        Box(Modifier.weight(1f)) { CStat("Deny events", traffic.denied.toString()) }
    }
    Spacer(Modifier.height(10.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.weight(1f)) { CStat("Log events", traffic.logged.toString()) }
        Box(Modifier.weight(1f)) { CStat("Rate-limit events", traffic.rateLimited.toString()) }
    }
    Spacer(Modifier.height(14.dp))
    CPanel(title = "Requests by hour") {
        if (traffic.buckets.isEmpty()) {
            CEmpty("No API calls stored in this window.")
        } else {
            HourBars(traffic.buckets.map { it.requests }, Modifier.fillMaxWidth().height(72.dp))
        }
    }
    Spacer(Modifier.height(14.dp))
    RankCard("Paths", traffic.topPaths.map { it.value to it.count }, "No paths stored.")
    RankCard("User agents", traffic.topAgents.map { it.value to it.count }, "No user agent stored.")
    RankCard("JA4 headers", traffic.topJa4.map { it.value to it.count }, "No JA4 header observed.")
    RankCard("Crawler names in User-Agent", traffic.crawlerTokens.map { it.value to it.count }, "No known crawler token in a stored User-Agent.")
    Spacer(Modifier.height(6.dp))
    CPanel {
        traffic.notes.forEach { note ->
            Text("• $note", color = Aurora.TextMid, fontSize = 12.sp, modifier = Modifier.padding(vertical = 3.dp))
        }
    }
}

@Composable
private fun RankCard(title: String, rows: List<Pair<String, Int>>, empty: String) {
    CPanel(modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp), title = title) {
        if (rows.isEmpty()) {
            CEmpty(empty)
        } else {
            rows.forEach { (value, count) ->
                Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(value, color = Aurora.TextHi, fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 1)
                    Text(count.toString(), color = Aurora.TextMid, fontSize = 11.sp, fontFamily = AppFonts.Mono)
                }
            }
        }
    }
}

/* ----------------------------- Device login ---------------------------- */

@Composable
fun DevicePage(store: ConsoleStore) {
    val scope = rememberCoroutineScope()
    var userCode by remember { mutableStateOf("") }
    var deviceCode by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("Request a code, approve it in Settings, then poll.") }
    var token by remember { mutableStateOf<String?>(null) }

    PageHead("Device login", "RFC 8628 style code. The secret never goes into a shell prompt.")
    Spacer(Modifier.height(12.dp))
    CPanel {
        CButton("Request code", onClick = {
            scope.launch {
                try {
                    val data = store.client.request("auth/device/code", "POST")
                    val uc = data.optString("userCode")
                    val dc = data.optString("deviceCode")
                    if (uc.isEmpty() || dc.isEmpty()) {
                        status = data.optString("error").ifEmpty { "Could not start a device code" }
                    } else {
                        userCode = uc
                        deviceCode = dc
                        token = null
                        status = "Waiting for approval. Confirm this code in Settings."
                    }
                } catch (e: Exception) {
                    status = e.message ?: "Could not start a device code"
                }
            }
        })
        if (userCode.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Hint("User code: $userCode")
        }
        Spacer(Modifier.height(8.dp))
        Hint(status)
        Spacer(Modifier.height(10.dp))
        CButton("Poll for token", onClick = {
            scope.launch {
                try {
                    val data = store.client.request("auth/device/token", "POST", jobj("deviceCode" to deviceCode).toString())
                    val t = data.optString("token")
                    status = if (data.optString("status") == "approved" && t.isNotEmpty()) {
                        token = t
                        "Approved. The token is shown once and stored only as a hash."
                    } else if (data.optString("status") == "pending") {
                        "Still waiting for approval."
                    } else {
                        data.optString("error").ifEmpty { data.optString("status").ifEmpty { "Not approved" } }
                    }
                } catch (e: Exception) {
                    status = e.message ?: "Not approved"
                }
            }
        }, kind = BtnKind.GHOST, enabled = deviceCode.isNotEmpty())
        token?.let {
            Spacer(Modifier.height(10.dp))
            Hint("Access token: $it")
        }
    }
}

/* ------------------------------- Settings ------------------------------ */

@Composable
fun SettingsPage(store: ConsoleStore) {
    val snap = store.snapshot ?: return
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf(snap.user?.name ?: "") }
    var tokenName by remember { mutableStateOf("") }
    var days by remember { mutableStateOf("30") }
    var shown by remember { mutableStateOf<String?>(null) }
    var hookUrl by remember { mutableStateOf("") }
    var hookSecret by remember { mutableStateOf<String?>(null) }
    var gate by remember { mutableStateOf("") }
    var device by remember { mutableStateOf("") }

    PageHead("Settings", "Sessions, tokens, and the identity providers this server can actually use.")
    Spacer(Modifier.height(12.dp))

    CPanel(title = "Display name") {
        CField("Display name", name, { name = it })
        Spacer(Modifier.height(10.dp))
        CButton("Save name", onClick = {
            store.action(scope, "Name saved") { store.call("profile", jobj("name" to name)) }
        }, enabled = name.isNotBlank())
    }

    Spacer(Modifier.height(14.dp))
    CPanel {
        CToggleRow(
            "Record page views",
            "When on, opening a page writes a log line and a request sample.",
            snap.settings.recordPageViews,
        ) { value ->
            store.action(scope, "Setting saved") { store.call("settings", jobj("recordPageViews" to value)) }
        }
    }

    Spacer(Modifier.height(14.dp))
    CPanel(title = "Sessions", subtitle = "This browser session stays until you sign out. Other sessions can be revoked.") {
        if (snap.sessions.isEmpty()) {
            CEmpty("No sessions recorded.")
        } else {
            snap.sessions.forEach { s ->
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(if (s.current) "This browser" else "Other session", color = Aurora.TextHi, fontSize = 13.sp)
                        Text(s.userAgent.ifEmpty { "unknown" }, color = Aurora.TextMid, fontSize = 11.sp, maxLines = 1)
                    }
                    if (!s.current) {
                        CButton("Revoke", onClick = {
                            store.action(scope, "Session revoked") { store.call("sessions/${s.id}", null, "DELETE") }
                        }, kind = BtnKind.GHOST, compact = true)
                    }
                }
            }
        }
    }

    Spacer(Modifier.height(14.dp))
    CPanel(title = "Access tokens") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { CField("Name", tokenName, { tokenName = it }, placeholder = "Name") }
        }
        Spacer(Modifier.height(8.dp))
        CSelect(
            listOf("7", "30", "90", "0"), days, { days = it }, modifier = Modifier.fillMaxWidth(),
            label = { if (it == "0") "No expiry" else "$it days" },
        )
        Spacer(Modifier.height(10.dp))
        CButton("Create", onClick = {
            scope.launch {
                try {
                    val result = store.call("tokens", jobj("name" to tokenName, "days" to days.toInt()))
                    shown = result.optString("token").ifEmpty { null }
                    tokenName = ""
                    store.notify("Token created. Copy it now. It is stored only as a hash.")
                } catch (e: Exception) {
                    store.notify(e.message ?: "Request failed")
                }
            }
        }, enabled = tokenName.isNotBlank())
        shown?.let {
            Spacer(Modifier.height(10.dp))
            Hint("Shown once: $it")
        }
        snap.tokens.forEach { token ->
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(token.name, color = Aurora.TextHi, fontSize = 13.sp)
                    Text("${token.prefix}… · ${if (token.expiresAt != null) "expires" else "no expiry"}", color = Aurora.TextMid, fontSize = 11.sp)
                }
                CButton("Revoke", onClick = {
                    store.action(scope, "Token revoked") { store.call("tokens/${token.id}", null, "DELETE") }
                }, kind = BtnKind.GHOST, compact = true)
            }
        }
    }

    Spacer(Modifier.height(14.dp))
    CPanel(title = "Approve a device code", subtitle = "A client calls the device-code API, then you confirm the code here. No password is entered in a shell.") {
        CField("Device code", device, { device = it }, placeholder = "ABCD-EFGH")
        Spacer(Modifier.height(10.dp))
        CButton("Approve", onClick = {
            store.action(scope, "Device approved") { store.call("device/approve", jobj("userCode" to device)) }
            device = ""
        }, enabled = device.isNotBlank())
    }

    Spacer(Modifier.height(14.dp))
    CPanel(title = "Console password", subtitle = "Optional extra password for this browser. It is stored as a scrypt hash. This is not an edge network gate.") {
        CField("Console password", gate, { gate = it }, placeholder = "At least 8 characters", password = true)
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CButton("Set password", onClick = {
                store.action(scope, "Console password saved") { store.call("protection", jobj("password" to gate)) }
                gate = ""
            }, enabled = gate.length >= 8)
            if (snap.protection.required) {
                CButton("Remove password", onClick = {
                    store.action(scope, "Console password removed") { store.call("protection", null, "DELETE") }
                }, kind = BtnKind.GHOST)
            }
        }
    }

    Spacer(Modifier.height(14.dp))
    CPanel(
        title = "Webhooks",
        subtitle = "This server POSTs JSON and an HMAC-SHA256 signature when a deployment is blocked, a firewall rule denies a request, or a session is created. Delivery errors are not retried.",
    ) {
        CField("Webhook URL", hookUrl, { hookUrl = it }, placeholder = "https://example.com/hooks")
        Spacer(Modifier.height(10.dp))
        CButton("Add", onClick = {
            scope.launch {
                try {
                    val result = store.call("webhooks", jobj("url" to hookUrl))
                    hookSecret = result.optString("secret").ifEmpty { null }
                    hookUrl = ""
                    store.notify("Webhook saved. Copy the signing secret.")
                } catch (e: Exception) {
                    store.notify(e.message ?: "Request failed")
                }
            }
        }, enabled = hookUrl.isNotBlank())
        hookSecret?.let {
            Spacer(Modifier.height(10.dp))
            Hint("Signing secret, shown once: $it")
        }
        snap.webhooks.forEach { hook ->
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(hook.url, color = Aurora.TextHi, fontSize = 13.sp, maxLines = 1)
                    Text(hook.events, color = Aurora.TextMid, fontSize = 11.sp)
                }
                CButton("Remove", onClick = {
                    store.action(scope, "Webhook removed") { store.call("webhooks/${hook.id}", null, "DELETE") }
                }, kind = BtnKind.GHOST, compact = true)
            }
        }
    }

    Spacer(Modifier.height(14.dp))
    CPanel(title = "Identity providers") {
        if (snap.identity.isEmpty()) {
            CEmpty("No identity providers configured.")
        } else {
            snap.identity.forEach { item ->
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(item.name, color = Aurora.TextHi, fontSize = 13.sp)
                        Text(item.detail, color = Aurora.TextMid, fontSize = 11.sp)
                    }
                    CBadge(item.state, if (item.state == "active") Tone.OK else Tone.WARN)
                }
            }
        }
    }
}
