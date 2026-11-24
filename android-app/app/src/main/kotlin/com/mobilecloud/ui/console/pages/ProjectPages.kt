package com.mobilecloud.ui.console.pages

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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Smartphone
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.console.ConsoleStore
import com.mobilecloud.console.Fmt
import com.mobilecloud.console.HostInfo
import com.mobilecloud.ui.console.BarChart
import com.mobilecloud.ui.console.BtnKind
import com.mobilecloud.ui.console.CBadge
import com.mobilecloud.ui.console.CButton
import com.mobilecloud.ui.console.CEmpty
import com.mobilecloud.ui.console.CField
import com.mobilecloud.ui.console.CPanel
import com.mobilecloud.ui.console.CSelect
import com.mobilecloud.ui.console.ConfirmDialog
import com.mobilecloud.ui.console.CRow
import com.mobilecloud.ui.console.CStat
import com.mobilecloud.ui.console.CTableHead
import com.mobilecloud.ui.console.Hint
import com.mobilecloud.ui.console.PageHead
import com.mobilecloud.ui.console.RangeTabs
import com.mobilecloud.ui.console.action
import com.mobilecloud.ui.console.ctime
import com.mobilecloud.ui.console.jobj
import com.mobilecloud.ui.console.statusTone
import com.mobilecloud.ui.theme.AppFonts
import com.mobilecloud.ui.theme.Aurora

private val RANGES = listOf("1h", "24h", "7d", "30d")

/* ------------------------------ Overview ------------------------------- */

@Composable
fun OverviewPage(store: ConsoleStore, onNavigate: (String) -> Unit) {
    val snap = store.snapshot ?: return
    val scope = rememberCoroutineScope()
    val q = store.query.trim().lowercase()
    val projects = snap.projects.filter { q.isEmpty() || it.name.lowercase().contains(q) }
    val deployments = snap.deployments.filter { q.isEmpty() || it.project.lowercase().contains(q) }.take(6)
    val metrics = snap.metrics
    val analytics = store.analytics

    Text("Welcome, ${snap.user?.name ?: ""}", color = Aurora.TextHi, fontSize = 20.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp)
    Spacer(Modifier.height(4.dp))
    Text("Figures below are read from this server. Missing measurements stay blank.", color = Aurora.TextMid, fontSize = 12.sp)
    Spacer(Modifier.height(12.dp))
    DeviceChip(snap.host) { onNavigate("/node") }
    Spacer(Modifier.height(16.dp))

    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.weight(1f)) {
            CStat("Deployment records", snap.deployments.size.toString(), hint = "Rows stored for your account")
        }
        Box(Modifier.weight(1f)) {
            CStat("Process uptime", metrics?.let { Fmt.duration(it.processUptimeSec) } ?: "—", hint = "This Node process, not a phone")
        }
    }
    Spacer(Modifier.height(10.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.weight(1f)) {
            CStat(
                "Average response",
                metrics?.responseAvgMs?.let { "$it ms" } ?: "No samples",
                hint = metrics?.let { "${it.responseSamples} requests in 24h" } ?: "Waiting for metrics",
            )
        }
        Box(Modifier.weight(1f)) {
            CStat("Data directory", metrics?.let { Fmt.bytes(it.dataDirBytes) } ?: "—", hint = "Files under the server data folder")
        }
    }

    Spacer(Modifier.height(16.dp))
    CPanel(
        title = "Recorded requests",
        actions = { RangeTabs(RANGES, store.range, { store.chooseRange(it) }) },
    ) {
        Hint("Counts of HTTP calls this server logged for your account. Collected ${metrics?.let { ctime(it.collectedAt) } ?: "—"}.")
        Spacer(Modifier.height(10.dp))
        when {
            analytics == null -> Hint("Loading…")
            analytics.total == 0 -> CEmpty("No requests recorded in this window.")
            else -> BarChart(analytics.points.map { it.count }, Modifier.fillMaxWidth().height(90.dp))
        }
    }

    Spacer(Modifier.height(14.dp))
    CPanel(title = "Deployments", actions = { Text("View all", color = Aurora.Cyan, fontSize = 12.sp, modifier = Modifier.clickable { onNavigate("/deployments") }) }) {
        if (deployments.isEmpty()) {
            CEmpty("No deployments recorded. Creating one stays blocked until a build runner is configured.")
        } else {
            deployments.forEach { d ->
                CRow {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(d.project, color = Aurora.TextHi, fontSize = 13.sp, modifier = Modifier.weight(1f))
                        CBadge(d.status, statusTone(d.status))
                        Spacer(Modifier.width(10.dp))
                        Text(ctime(d.createdAt), color = Aurora.TextMid, fontSize = 11.sp)
                    }
                }
            }
        }
    }

    Spacer(Modifier.height(14.dp))
    CPanel(title = "Projects", actions = { Text("Manage", color = Aurora.Cyan, fontSize = 12.sp, modifier = Modifier.clickable { onNavigate("/projects") }) }) {
        if (projects.isEmpty()) {
            CEmpty("No projects yet. Create one from the Projects page.")
        } else {
            projects.take(6).forEach { p ->
                val last = snap.deployments.firstOrNull { it.projectId == p.id }
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(p.name, color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            "${p.framework} · ${p.target}" + (last?.let { " · last ${it.status}" } ?: " · no deployment"),
                            color = Aurora.TextMid, fontSize = 11.sp,
                        )
                    }
                    CButton("Request deploy", onClick = {
                        store.action(scope, "Deployment recorded") { store.call("deployments", jobj("projectId" to p.id)) }
                    }, kind = BtnKind.GHOST, compact = true)
                }
            }
        }
    }

    Spacer(Modifier.height(14.dp))
    CPanel(title = "This host", actions = { Text("Details", color = Aurora.Cyan, fontSize = 12.sp, modifier = Modifier.clickable { onNavigate("/monitoring") }) }) {
        if (metrics == null) {
            CEmpty("Host metrics have not arrived.")
        } else {
            Meter("CPU since boot", metrics.cpuBusySinceBootPct, null)
            Meter("Memory", metrics.memoryUsedPct, "${Fmt.bytes(metrics.memoryUsedBytes)} / ${Fmt.bytes(metrics.memoryTotalBytes)}")
            val disk = if (metrics.diskTotalBytes != null && metrics.diskFreeBytes != null)
                ((1 - metrics.diskFreeBytes.toDouble() / metrics.diskTotalBytes.toDouble()) * 1000).let { Math.round(it) / 10.0 } else null
            Meter("Disk used", disk, metrics.diskTotalBytes?.let { "${Fmt.bytes(metrics.diskFreeBytes)} free" })
            Spacer(Modifier.height(6.dp))
            Hint("Network utilization is not measured. Phone battery and wall power are not visible to this process.")
            Spacer(Modifier.height(4.dp))
            Hint("Sampled ${ctime(metrics.collectedAt)} · process up ${Fmt.duration(metrics.processUptimeSec)}")
        }
    }
}

@Composable
private fun DeviceChip(host: HostInfo?, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Aurora.CardAlt)
            .border(1.dp, Aurora.Border, RoundedCornerShape(10.dp)).clickable { onClick() }.padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(32.dp).clip(RoundedCornerShape(8.dp)).background(Aurora.Cyan.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Smartphone, contentDescription = null, tint = Aurora.Cyan, modifier = Modifier.size(17.dp))
        }
        Spacer(Modifier.width(11.dp))
        Column(Modifier.weight(1f)) {
            Text(host?.hostname ?: "Host unread", color = Aurora.TextHi, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text(
                if (host != null) "${host.platform} · ${host.cpuCount} CPUs" else "Open the node page after the API responds.",
                color = Aurora.TextMid, fontSize = 11.sp,
            )
        }
    }
}

@Composable
private fun Meter(label: String, value: Double?, hint: String?) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = Aurora.TextMid, fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text(
                if (value == null) "Not measured" else "${if (value % 1.0 == 0.0) value.toLong().toString() else value}%",
                color = Aurora.TextHi, fontSize = 12.sp, fontFamily = AppFonts.Mono,
            )
        }
        if (value != null) {
            Spacer(Modifier.height(6.dp))
            Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(999.dp)).background(Aurora.Track)) {
                Box(
                    Modifier.fillMaxWidth((value / 100.0).toFloat().coerceIn(0f, 1f)).height(6.dp)
                        .clip(RoundedCornerShape(999.dp)).background(Aurora.Cyan)
                )
            }
        }
        if (hint != null) {
            Spacer(Modifier.height(4.dp))
            Text(hint, color = Aurora.TextMid, fontSize = 11.sp)
        }
    }
}

/* ------------------------------ Projects ------------------------------- */

@Composable
fun ProjectsPage(store: ConsoleStore) {
    val scope = rememberCoroutineScope()
    val q = store.query.trim().lowercase()
    val rows = (store.snapshot?.projects ?: emptyList()).filter { q.isEmpty() || "${it.name} ${it.framework}".lowercase().contains(q) }
    var name by remember { mutableStateOf("") }
    var framework by remember { mutableStateOf("Next.js") }
    var repoUrl by remember { mutableStateOf("") }
    var drop by remember { mutableStateOf<String?>(null) }

    PageHead("Projects", "Records stored in this server's database. A project does not deploy by itself.")
    Spacer(Modifier.height(12.dp))
    CPanel {
        CField("Project name", name, { name = it }, placeholder = "project-name")
        Spacer(Modifier.height(8.dp))
        CSelect(listOf("Next.js", "Vite", "Astro", "Nuxt", "Remix", "React"), framework, { framework = it })
        Spacer(Modifier.height(8.dp))
        CField("HTTPS repository URL (optional)", repoUrl, { repoUrl = it })
        Spacer(Modifier.height(10.dp))
        CButton("Create", onClick = {
            val submittedName = name
            val submittedRepo = repoUrl
            val payload = jobj("name" to submittedName, "framework" to framework, "repoUrl" to submittedRepo)
            store.action(scope, "Project saved") {
                store.call("projects", payload).also {
                    if (name == submittedName) name = ""
                    if (repoUrl == submittedRepo) repoUrl = ""
                }
            }
        }, enabled = name.isNotBlank() && !store.busy)
    }

    Spacer(Modifier.height(14.dp))
    if (rows.isEmpty()) {
        CEmpty("No projects stored for this account.")
    } else {
        rows.forEach { p ->
            val last = store.snapshot?.deployments?.firstOrNull { it.projectId == p.id }
            CPanel(modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                Text(p.name, color = Aurora.TextHi, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Text("${p.framework} · ${p.target}", color = Aurora.TextMid, fontSize = 11.sp)
                Spacer(Modifier.height(3.dp))
                Text(last?.let { "${it.status} · ${it.note}" } ?: "No deployment recorded", color = Aurora.TextMid, fontSize = 11.sp)
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CButton("Request deploy", onClick = {
                        store.action(scope, "Deployment request recorded") { store.call("deployments", jobj("projectId" to p.id)) }
                    }, enabled = p.repoUrl.isNotBlank() && !store.busy)
                    CButton("Delete", onClick = { drop = p.id }, kind = BtnKind.DANGER)
                }
            }
        }
    }

    drop?.let { id ->
        ConfirmDialog(
            title = "Delete this project?",
            body = "Deployments and domain records for it are removed. Files already written are left on disk.",
            onCancel = { drop = null },
            onConfirm = {
                drop = null
                store.action(scope, "Project deleted") { store.call("projects/$id", null, "DELETE") }
            },
        )
    }
}

/* ----------------------------- Deployments ----------------------------- */

@Composable
fun DeploymentsPage(store: ConsoleStore) {
    val q = store.query.trim().lowercase()
    var status by remember { mutableStateOf("All") }
    val rows = (store.snapshot?.deployments ?: emptyList())
        .filter { q.isEmpty() || "${it.project} ${it.status} ${it.note}".lowercase().contains(q) }
        .filter { status == "All" || it.status == status }

    PageHead("Deployments", "A request is stored as blocked unless a build runner accepts it. Nothing is marked ready from a timer.")
    Spacer(Modifier.height(12.dp))
    CSelect(listOf("All", "blocked", "failed"), status, { status = it }, modifier = Modifier.fillMaxWidth())
    Spacer(Modifier.height(12.dp))
    CPanel {
        CTableHead(listOf("Project", "Status", "When", "Note"))
        if (rows.isEmpty()) {
            CEmpty("No deployment records match.")
        } else {
            rows.forEach { d ->
                CRow {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(d.project, color = Aurora.TextHi, fontSize = 12.sp, modifier = Modifier.weight(1.4f))
                        CBadge(d.status, statusTone(d.status))
                        Spacer(Modifier.width(8.dp))
                        Text(ctime(d.createdAt), color = Aurora.TextMid, fontSize = 11.sp, modifier = Modifier.weight(0.9f))
                    }
                    Spacer(Modifier.height(3.dp))
                    Text(d.note, color = Aurora.TextMid, fontSize = 11.sp)
                }
            }
        }
    }
}

/* -------------------------------- Builds ------------------------------- */

@Composable
fun BuildsPage(store: ConsoleStore) {
    val scope = rememberCoroutineScope()
    val snap = store.snapshot ?: return
    val projects = snap.projects.filter { it.repoUrl.isNotBlank() }
    var selection by remember { mutableStateOf("") }
    val projectId = projects.firstOrNull { it.id == selection }?.id ?: projects.firstOrNull()?.id.orEmpty()

    PageHead("Web builds", "Requests are recorded, but this console does not execute builds. Android builds and cache purges are not supported here.")
    Spacer(Modifier.height(12.dp))
    CPanel(title = "Request a web build") {
        if (projects.isEmpty()) {
            CEmpty("Add a project with an HTTPS repository to record a build request.")
        } else {
            CSelect(
                projects.map { it.id }, projectId, { selection = it }, modifier = Modifier.fillMaxWidth(),
                label = { id -> projects.first { it.id == id }.name },
            )
            Spacer(Modifier.height(10.dp))
            CButton("Request web build", onClick = {
                val payload = jobj("projectId" to projectId, "target" to "web")
                store.action(scope, "Build request recorded") { store.call("builds", payload) }
            }, enabled = !store.busy)
        }
    }

    Spacer(Modifier.height(14.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.weight(1f)) {
            CStat(
                "Build requests",
                snap.builds.size.toString(),
                hint = "Rows stored for your account",
            )
        }
        Box(Modifier.weight(1f)) {
            CStat(
                "Awaiting a runner",
                snap.builds.count { it.status == "blocked" }.toString(),
                hint = "Stored but not accepted by a build runner",
            )
        }
    }
    Spacer(Modifier.height(14.dp))
    CPanel {
        if (snap.builds.isEmpty()) {
            CEmpty("No build requests stored.")
        } else {
            snap.builds.forEach { b ->
                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text("${b.project} · ${b.target} · ${b.status}", color = Aurora.TextHi, fontSize = 12.sp)
                    Text("${b.note} · ${ctime(b.createdAt)}", color = Aurora.TextMid, fontSize = 11.sp)
                }
            }
        }
    }
}
