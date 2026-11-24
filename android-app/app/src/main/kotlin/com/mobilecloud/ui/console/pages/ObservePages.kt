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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.console.ConsoleStore
import com.mobilecloud.console.Fmt
import com.mobilecloud.ui.console.BarChart
import com.mobilecloud.ui.console.CBadge
import com.mobilecloud.ui.console.CEmpty
import com.mobilecloud.ui.console.CPanel
import com.mobilecloud.ui.console.CRow
import com.mobilecloud.ui.console.CSelect
import com.mobilecloud.ui.console.CStat
import com.mobilecloud.ui.console.CTableHead
import com.mobilecloud.ui.console.Hint
import com.mobilecloud.ui.console.PageHead
import com.mobilecloud.ui.console.RangeTabs
import com.mobilecloud.ui.console.Tone
import com.mobilecloud.ui.console.ctime
import com.mobilecloud.ui.theme.AppFonts
import com.mobilecloud.ui.theme.Aurora

private val RANGES = listOf("1h", "24h", "7d", "30d")

/* --------------------------------- Logs -------------------------------- */

@Composable
fun LogsPage(store: ConsoleStore) {
    val q = store.query.trim().lowercase()
    var level by remember { mutableStateOf("All") }
    val rows = (store.snapshot?.logs ?: emptyList())
        .filter { q.isEmpty() || "${it.source} ${it.message}".lowercase().contains(q) }
        .filter { level == "All" || it.level == level }

    PageHead("Logs", "Entries written by this server for your account.")
    Spacer(Modifier.height(12.dp))
    CSelect(listOf("All", "info", "warn", "error"), level, { level = it }, modifier = Modifier.fillMaxWidth())
    Spacer(Modifier.height(12.dp))
    CPanel {
        if (rows.isEmpty()) {
            CEmpty("No log lines match.")
        } else {
            rows.forEach { l ->
                CRow {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        CBadge(
                            l.level,
                            when (l.level) {
                                "error" -> Tone.BAD
                                "warn" -> Tone.WARN
                                else -> Tone.INFO
                            },
                        )
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(l.message, color = Aurora.TextHi, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                            Text(l.source, color = Aurora.TextMid, fontSize = 11.sp)
                        }
                        Spacer(Modifier.width(8.dp))
                        Text(ctime(l.at), color = Aurora.TextMid, fontSize = 11.sp)
                    }
                }
            }
        }
    }
}

/* ------------------------------ Analytics ------------------------------ */

@Composable
fun AnalyticsPage(store: ConsoleStore) {
    val analytics = store.analytics
    val points = analytics?.points ?: emptyList()
    val step = if (points.isEmpty()) 1 else Math.ceil(points.size / 6.0).toInt().coerceAtLeast(1)

    PageHead("Analytics", "Requests this server recorded for your account." + (analytics?.let { " ${it.total} in view." } ?: ""))
    Spacer(Modifier.height(12.dp))
    RangeTabs(RANGES, store.range, { store.chooseRange(it) })
    Spacer(Modifier.height(12.dp))
    CPanel {
        when {
            analytics == null -> Hint("Loading…")
            analytics.total == 0 -> CEmpty("No requests recorded in this window.")
            else -> {
                BarChart(points.map { it.count }, Modifier.fillMaxWidth().height(120.dp))
                Spacer(Modifier.height(10.dp))
                Hint(points.filterIndexed { i, _ -> i % step == 0 }.joinToString("  ·  ") { it.label })
            }
        }
    }
}

/* ------------------------------ Monitoring ----------------------------- */

@Composable
fun MonitoringPage(store: ConsoleStore) {
    val m = store.snapshot?.metrics
    PageHead("Monitoring", "Values come from the operating system and this process. Unmeasured signals are listed, not drawn as zero.")
    Spacer(Modifier.height(12.dp))
    if (m == null) {
        CEmpty("Metrics are unavailable.")
        return
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.weight(1f)) {
            CStat("CPU busy since boot", m.cpuBusySinceBootPct?.let { "$it%" } ?: "Not measured", hint = "From os.cpus() times, not a live interval.")
        }
        Box(Modifier.weight(1f)) {
            CStat("Memory", m.memoryUsedPct?.let { "$it%" } ?: "Not measured", hint = "${Fmt.bytes(m.memoryUsedBytes)} of ${Fmt.bytes(m.memoryTotalBytes)}")
        }
    }
    Spacer(Modifier.height(10.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.weight(1f)) {
            CStat(
                "Disk",
                m.diskFreeBytes?.let { "${Fmt.bytes(it)} free" } ?: "Not measured",
                hint = (m.diskTotalBytes?.let { "of ${Fmt.bytes(it)}" } ?: "statfs unread") + " · data dir ${Fmt.bytes(m.dataDirBytes)}",
            )
        }
        Box(Modifier.weight(1f)) {
            CStat(
                "Responses",
                m.responseAvgMs?.let { "$it ms" } ?: "No samples",
                hint = "${m.responseSamples} logged requests in 24h · process ${Fmt.duration(m.processUptimeSec)}",
            )
        }
    }
    Spacer(Modifier.height(14.dp))
    CPanel(title = "Not measured") {
        m.unavailable.forEach { line ->
            Text("• $line", color = Aurora.TextMid, fontSize = 12.sp, modifier = Modifier.padding(vertical = 3.dp))
        }
        Spacer(Modifier.height(6.dp))
        Hint("Collected ${ctime(m.collectedAt)}")
    }
}

/* ---------------------------- Observability ---------------------------- */

@Composable
fun ObservabilityPage(store: ConsoleStore) {
    val data = store.snapshot?.observability
    PageHead("Observability", "Status counts and latency percentiles from requests this server stored in the last 24 hours.")
    Spacer(Modifier.height(12.dp))
    if (data == null) {
        CEmpty("No observability sample yet.")
        return
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.weight(1f)) { CStat("Requests", data.samples.toString()) }
        Box(Modifier.weight(1f)) { CStat("p50 duration", data.p50?.let { "$it ms" } ?: "No samples") }
    }
    Spacer(Modifier.height(10.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.weight(1f)) { CStat("p95 duration", data.p95?.let { "$it ms" } ?: "No samples") }
        Box(Modifier.weight(1f)) { CStat("p99 duration", data.p99?.let { "$it ms" } ?: "No samples") }
    }
    Spacer(Modifier.height(14.dp))
    CPanel {
        Hint("2xx ${data.statuses.s2xx} · 3xx ${data.statuses.s3xx} · 4xx ${data.statuses.s4xx} · 5xx ${data.statuses.s5xx}")
        Spacer(Modifier.height(8.dp))
        data.unavailable.forEach { line ->
            Text("• $line", color = Aurora.TextMid, fontSize = 12.sp, modifier = Modifier.padding(vertical = 3.dp))
        }
    }
}

/* -------------------------------- Speed -------------------------------- */

@Composable
fun SpeedPage(store: ConsoleStore) {
    val vitals = store.snapshot?.vitals
    PageHead("Speed", vitals?.note ?: "Web vitals recorded from the console.")
    Spacer(Modifier.height(12.dp))
    CPanel(title = "Real Experience Score") {
        Text(
            vitals?.res?.let { if (it % 1.0 == 0.0) it.toLong().toString() else it.toString() } ?: "No samples",
            color = Aurora.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold, fontFamily = AppFonts.Mono,
        )
    }
    Spacer(Modifier.height(12.dp))
    (vitals?.metrics ?: emptyList()).forEach { metric ->
        CPanel(modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp), title = metric.metric) {
            Text(
                metric.p75?.let { if (metric.metric == "CLS") String.format(java.util.Locale.US, "%.3f", it) else "${Math.round(it)} ms" } ?: "No samples",
                color = Aurora.TextHi, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, fontFamily = AppFonts.Mono,
            )
            Spacer(Modifier.height(3.dp))
            Hint("${metric.samples} samples · p75")
        }
    }
    if ((vitals?.metrics ?: emptyList()).isEmpty()) CEmpty("No web-vital samples recorded.")
}
