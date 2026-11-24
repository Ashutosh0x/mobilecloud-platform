package com.mobilecloud.ui.console.pages

import android.util.Base64
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import com.mobilecloud.console.ConsoleStore
import com.mobilecloud.console.Fmt
import com.mobilecloud.ui.console.BtnKind
import com.mobilecloud.ui.console.CButton
import com.mobilecloud.ui.console.CEmpty
import com.mobilecloud.ui.console.CField
import com.mobilecloud.ui.console.CPanel
import com.mobilecloud.ui.console.CSelect
import com.mobilecloud.ui.console.ConfirmDialog
import com.mobilecloud.ui.console.Hint
import com.mobilecloud.ui.console.PageHead
import com.mobilecloud.ui.console.action
import com.mobilecloud.ui.console.jobj
import com.mobilecloud.ui.theme.AppFonts
import com.mobilecloud.ui.theme.Aurora

/* -------------------------------- Domains ------------------------------ */

@Composable
fun DomainsPage(store: ConsoleStore) {
    val snap = store.snapshot ?: return
    val scope = rememberCoroutineScope()
    val q = store.query.trim().lowercase()
    var host by remember { mutableStateOf("") }
    var project by remember { mutableStateOf(snap.projects.firstOrNull()?.name ?: "") }
    var drop by remember { mutableStateOf<String?>(null) }
    val rows = snap.domains.filter { q.isEmpty() || "${it.host} ${it.project}".lowercase().contains(q) }

    PageHead("Domains", "Hostnames are saved locally. No DNS provider is configured, so nothing is published.")
    Spacer(Modifier.height(12.dp))
    CPanel(title = "Record a hostname") {
        CField("Hostname", host, { host = it }, placeholder = "app.example.com")
        Spacer(Modifier.height(8.dp))
        if (snap.projects.isNotEmpty()) {
            com.mobilecloud.ui.console.CSelect(
                snap.projects.map { it.name }, project, { project = it }, modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.height(10.dp))
        CButton("Record", onClick = {
            store.action(scope, "Hostname recorded") { store.call("domains", jobj("host" to host, "project" to project)) }
            host = ""
        }, enabled = host.isNotBlank() && snap.projects.isNotEmpty())
    }

    Spacer(Modifier.height(14.dp))
    CPanel {
        if (rows.isEmpty()) {
            CEmpty("No hostnames recorded.")
        } else {
            rows.forEach { d ->
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(d.host, color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Text("${d.project} · ${d.status} · ${d.detail}", color = Aurora.TextMid, fontSize = 11.sp)
                    }
                    CButton("Remove", onClick = { drop = d.id }, kind = BtnKind.DANGER, compact = true)
                }
            }
        }
    }

    drop?.let { id ->
        ConfirmDialog(
            title = "Remove this hostname?",
            body = "Only the local record is deleted.",
            onCancel = { drop = null },
            onConfirm = {
                drop = null
                store.action(scope, "Hostname removed") { store.call("domains/$id", null, "DELETE") }
            },
        )
    }
}

/* -------------------------------- Storage ------------------------------ */

@Composable
fun StoragePage(store: ConsoleStore) {
    val snap = store.snapshot ?: return
    val scope = rememberCoroutineScope()
    val q = store.query.trim().lowercase()
    var bucket by remember { mutableStateOf("assets") }
    var key by remember { mutableStateOf("") }
    var content by remember { mutableStateOf("") }
    val rows = snap.objects.filter { q.isEmpty() || "${it.bucket} ${it.key}".lowercase().contains(q) }
    val used = snap.objects.sumOf { it.bytes }

    PageHead("Storage", "Uploads are written under the server data directory, up to 1 MB. Usage is the sum of stored file sizes: ${Fmt.bytes(used)}.")
    Spacer(Modifier.height(12.dp))
    CPanel(title = "Upload object") {
        CField("Bucket", bucket, { bucket = it })
        Spacer(Modifier.height(8.dp))
        CField("Object key", key, { key = it }, placeholder = "notes/readme.txt")
        Spacer(Modifier.height(8.dp))
        CField("Contents", content, { content = it }, placeholder = "file contents")
        Spacer(Modifier.height(10.dp))
        CButton("Upload", onClick = {
            val submittedContent = content
            val payload = jobj("bucket" to bucket, "key" to key, "contentBase64" to Base64.encodeToString(submittedContent.toByteArray(Charsets.UTF_8), Base64.NO_WRAP))
            store.action(scope, "Object written") {
                store.call("storage", payload).also { if (content == submittedContent) content = "" }
            }
        }, enabled = bucket.isNotBlank() && key.isNotBlank() && content.isNotBlank())
    }

    Spacer(Modifier.height(14.dp))
    CPanel {
        if (rows.isEmpty()) {
            CEmpty("No objects stored.")
        } else {
            rows.forEach { o ->
                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text("${o.bucket}/${o.key}", color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text("${Fmt.bytes(o.bytes)} on disk", color = Aurora.TextMid, fontSize = 11.sp)
                }
            }
        }
    }
}

/* ------------------------------ Databases ------------------------------ */

@Composable
fun DatabasesPage(store: ConsoleStore) {
    val snap = store.snapshot ?: return
    val scope = rememberCoroutineScope()
    val q = store.query.trim().lowercase()
    var name by remember { mutableStateOf("") }
    val rows = snap.databases.filter { q.isEmpty() || it.name.lowercase().contains(q) }

    PageHead("Databases", "Each database is an empty SQLite file on this server. Size is read from the filesystem.")
    Spacer(Modifier.height(12.dp))
    CPanel(title = "Create a database file") {
        CField("Database name", name, { name = it }, placeholder = "ledger")
        Spacer(Modifier.height(10.dp))
        CButton("Create file", onClick = {
            store.action(scope, "Database file created") { store.call("databases", jobj("name" to name)) }
            name = ""
        }, enabled = name.isNotBlank())
    }

    Spacer(Modifier.height(14.dp))
    CPanel {
        if (rows.isEmpty()) {
            CEmpty("No database files yet.")
        } else {
            rows.forEach { d ->
                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text(d.name, color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text("${d.engine} · ${d.bytes?.let { Fmt.bytes(it) } ?: "file missing"}", color = Aurora.TextMid, fontSize = 11.sp)
                }
            }
        }
    }
}

/* ------------------------------ Functions ------------------------------ */

@Composable
fun FunctionsPage(store: ConsoleStore) {
    val snap = store.snapshot ?: return
    val scope = rememberCoroutineScope()
    val q = store.query.trim().lowercase()
    var name by remember { mutableStateOf("") }
    var route by remember { mutableStateOf("/api/") }
    val rows = snap.functions.filter { q.isEmpty() || "${it.name} ${it.route}".lowercase().contains(q) }

    PageHead("Functions", "Registration stores a name and route only. Function execution is not supported here.")
    Spacer(Modifier.height(12.dp))
    CPanel(title = "Register a function") {
        CField("Function name", name, { name = it }, placeholder = "quote")
        Spacer(Modifier.height(8.dp))
        CField("Route", route, { route = it })
        Spacer(Modifier.height(10.dp))
        CButton("Register", onClick = {
            val submittedName = name
            val payload = jobj("name" to submittedName, "route" to route)
            store.action(scope, "Function registered") {
                store.call("functions", payload).also { if (name == submittedName) name = "" }
            }
        }, enabled = name.isNotBlank() && route.isNotBlank() && !store.busy)
    }

    Spacer(Modifier.height(14.dp))
    CPanel {
        if (rows.isEmpty()) {
            CEmpty("No functions registered.")
        } else {
            rows.forEach { f ->
                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text(f.name, color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        "${f.route} · source ${if (f.hasSource) "stored" else "missing"} · ${f.invocations} invocations",
                        color = Aurora.TextMid, fontSize = 11.sp,
                    )
                }
            }
        }
    }
}

/* ------------------------------ Workflows ------------------------------ */

@Composable
fun WorkflowsPage(store: ConsoleStore) {
    val snap = store.snapshot ?: return
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var drive by remember { mutableStateOf("") }

    PageHead("Workflows and drives", "Workflow runs are recorded and not executed. Drives are real directories on this server, not microVM volumes.")
    Spacer(Modifier.height(12.dp))
    CPanel(title = "Save a workflow") {
        CField("Workflow name", name, { name = it }, placeholder = "nightly-audit")
        Spacer(Modifier.height(10.dp))
        CButton("Save workflow", onClick = {
            store.action(scope, "Workflow saved") { store.call("workflows", jobj("name" to name)) }
            name = ""
        }, enabled = name.isNotBlank())
    }

    Spacer(Modifier.height(14.dp))
    CPanel {
        if (snap.workflows.isEmpty()) {
            CEmpty("No workflows stored.")
        } else {
            snap.workflows.forEach { w ->
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(w.name, color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            w.lastRun?.let { "${it.status}: ${it.note}" } ?: "No run recorded",
                            color = Aurora.TextMid, fontSize = 11.sp,
                        )
                    }
                    CButton("Record run", onClick = {
                        store.action(scope, "Recorded") { store.call("workflows/${w.id}/run") }
                    }, kind = BtnKind.GHOST, compact = true)
                }
            }
        }
    }

    Spacer(Modifier.height(14.dp))
    CPanel(title = "Create a drive directory") {
        CField("Drive name", drive, { drive = it }, placeholder = "workspace")
        Spacer(Modifier.height(10.dp))
        CButton("Create drive directory", onClick = {
            store.action(scope, "Directory created") { store.call("drives", jobj("name" to drive)) }
            drive = ""
        }, enabled = drive.isNotBlank())
    }

    Spacer(Modifier.height(14.dp))
    CPanel {
        if (snap.drives.isEmpty()) {
            CEmpty("No drive directories yet.")
        } else {
            snap.drives.forEach { item ->
                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text(item.name, color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(item.bytes?.let { "${Fmt.bytes(it)} on disk" } ?: "unreadable", color = Aurora.TextMid, fontSize = 11.sp)
                }
            }
        }
    }

    Spacer(Modifier.height(14.dp))
    CPanel(title = "Platform boundaries") {
        snap.capabilities.forEach { item ->
            Column(Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
                Text(item.name, color = Aurora.TextHi, fontSize = 13.sp)
                Text(
                    "${item.state} · ${item.detail}",
                    color = if (item.state == "unavailable") Aurora.Amber else Aurora.TextMid,
                    fontSize = 11.sp,
                )
            }
        }
    }
}

/* ----------------------------- Node console ---------------------------- */

@Composable
fun NodeConsolePage(store: ConsoleStore, onNavigate: (String) -> Unit) {
    val host = store.snapshot?.host
    PageHead("Node console", "This page reports the computer running the web server. Battery, bypass charging, and wall power are not available here.")
    Spacer(Modifier.height(10.dp))
    CButton("Back to dashboard", onClick = { onNavigate("/") }, kind = BtnKind.GHOST, compact = true)
    Spacer(Modifier.height(14.dp))
    if (host == null) {
        CEmpty("Host information has not arrived.")
        return
    }
    CPanel(title = "Host") {
        Text(host.hostname, color = Aurora.TextHi, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, fontFamily = AppFonts.Mono)
        Spacer(Modifier.height(3.dp))
        Hint("${host.platform} ${host.release} · ${host.arch} · ${host.cpuCount} CPUs")
    }
    Spacer(Modifier.height(12.dp))
    CPanel(title = "Process uptime") {
        Text(Fmt.duration(host.processUptimeSec), color = Aurora.TextHi, fontSize = 18.sp, fontWeight = FontWeight.Bold, fontFamily = AppFonts.Mono)
        Spacer(Modifier.height(3.dp))
        Hint("Time since this Node process started.")
    }
    Spacer(Modifier.height(12.dp))
    CPanel(title = "Memory") {
        Text(Fmt.bytes(host.memoryUsedBytes), color = Aurora.TextHi, fontSize = 18.sp, fontWeight = FontWeight.Bold, fontFamily = AppFonts.Mono)
        Spacer(Modifier.height(3.dp))
        Hint("of ${Fmt.bytes(host.memoryTotalBytes)} reported by the OS")
    }
    Spacer(Modifier.height(12.dp))
    CPanel(title = "Not available from this process") {
        host.unavailable.forEach { line ->
            Text("• $line", color = Aurora.TextMid, fontSize = 12.sp, modifier = Modifier.padding(vertical = 3.dp))
        }
    }
}

/* --------------------------------- Team -------------------------------- */

@Composable
fun TeamPage(store: ConsoleStore) {
    val snap = store.snapshot ?: return
    val scope = rememberCoroutineScope()
    val q = store.query.trim().lowercase()
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    val rows = snap.team.filter { q.isEmpty() || "${it.name} ${it.email}".lowercase().contains(q) }

    PageHead("Team", "Invites are stored. SMTP is not configured, so no email is sent.")
    Spacer(Modifier.height(12.dp))
    CPanel(title = "Save an invite") {
        CField("Name", name, { name = it }, placeholder = "Name")
        Spacer(Modifier.height(8.dp))
        CField("Email", email, { email = it }, placeholder = "Email")
        Spacer(Modifier.height(10.dp))
        CButton("Save invite", onClick = {
            val submittedName = name
            val submittedEmail = email
            val payload = jobj("name" to submittedName, "email" to submittedEmail)
            store.action(scope, "Invite saved. No email was sent.") {
                store.call("team", payload).also {
                    if (name == submittedName) name = ""
                    if (email == submittedEmail) email = ""
                }
            }
        }, enabled = name.isNotBlank() && email.isNotBlank())
    }

    Spacer(Modifier.height(14.dp))
    CPanel {
        if (rows.isEmpty()) {
            CEmpty("No team members or invites stored.")
        } else {
            rows.forEach { m ->
                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text(m.name, color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        "${m.email} · ${m.role} · ${if (m.emailSent) "account" else "invite stored, email not sent"}",
                        color = Aurora.TextMid, fontSize = 11.sp,
                    )
                }
            }
        }
    }
}

/* -------------------------------- Billing ------------------------------ */

@Composable
fun BillingPage(store: ConsoleStore) {
    val snap = store.snapshot ?: return
    val scope = rememberCoroutineScope()
    val plans = listOf("community", "mesh", "hardware")

    PageHead("Billing", snap.billing?.detail ?: "")
    Spacer(Modifier.height(12.dp))
    plans.forEach { plan ->
        val on = snap.billing?.plan == plan
        Box(
            Modifier
                .fillMaxWidth()
                .padding(bottom = 10.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Aurora.Card)
                .border(1.dp, if (on) Aurora.Cyan else Aurora.Border, RoundedCornerShape(12.dp))
                .clickable {
                    store.action(scope, "Plan preference saved. Nothing was charged.") { store.call("billing", jobj("plan" to plan)) }
                }
                .padding(16.dp),
        ) {
            Column {
                Text(plan, color = Aurora.TextHi, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(3.dp))
                Text(
                    if (on) "Stored preference" else "Save as preference",
                    color = if (on) Aurora.Cyan else Aurora.TextMid, fontSize = 11.sp,
                )
            }
        }
    }
}
