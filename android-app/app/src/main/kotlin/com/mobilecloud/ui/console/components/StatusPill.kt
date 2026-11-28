package com.mobilecloud.ui.console.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.console.Domain
import com.mobilecloud.ui.console.CBadge
import com.mobilecloud.ui.console.Tone
import com.mobilecloud.ui.console.toneColor
import com.mobilecloud.ui.theme.Aurora
import java.time.Instant
import java.time.ZoneId

/* =========================================================================
 * DOMAIN STATUS PRESENTATION — a 1:1 port of the web `DomainDnsCard.tsx`
 * maps. The three signals (DNS / SSL / Health) each render as their own tile
 * and are never merged into one colour; only the lifecycle pill, which the
 * server derives, summarises all three.
 * ========================================================================= */

/** Lifecycle status → human label (web `STATUS_LABEL`). */
fun domainStatusLabel(status: String): String = when (status) {
    "pending_dns" -> "Pending DNS"
    "dns_verified" -> "DNS verified"
    "ssl_provisioning" -> "SSL provisioning"
    "active" -> "Active"
    "ssl_expiring" -> "SSL expiring"
    "ssl_expired" -> "SSL expired"
    "dns_misconfigured" -> "DNS misconfigured"
    "suspended" -> "Suspended"
    "deleting" -> "Deleting"
    else -> status
}

/** Lifecycle status → badge tone (web `STATUS_BADGE`). */
fun domainStatusTone(status: String): Tone = when (status) {
    "active" -> Tone.OK
    "ssl_expired", "dns_misconfigured", "suspended", "deleting" -> Tone.BAD
    "pending_dns", "dns_verified", "ssl_provisioning", "ssl_expiring" -> Tone.WARN
    else -> Tone.NEUTRAL
}

fun dnsSignalLabel(value: String): String = when (value) {
    "pending" -> "Pending"; "verified" -> "Verified"; "missing" -> "Not found"; "misconfigured" -> "Misconfigured"; else -> value
}

fun dnsSignalTone(value: String): Tone = when (value) {
    "verified" -> Tone.OK; "missing", "misconfigured" -> Tone.BAD; "pending" -> Tone.WARN; else -> Tone.NEUTRAL
}

fun sslSignalLabel(value: String): String = when (value) {
    "none" -> "Not started"; "provisioning" -> "Provisioning"; "active" -> "Active"
    "renewing" -> "Renewing"; "expired" -> "Expired"; "failed" -> "Failed"; else -> value
}

fun sslSignalTone(value: String): Tone = when (value) {
    "active" -> Tone.OK; "expired", "failed" -> Tone.BAD; "provisioning", "renewing" -> Tone.WARN; else -> Tone.NEUTRAL
}

fun healthSignalLabel(value: String): String = when (value) {
    "ok" -> "Healthy"; "degraded" -> "Degraded"; "down" -> "Down"; "unknown" -> "Unknown"; else -> value
}

fun healthSignalTone(value: String): Tone = when (value) {
    "ok" -> Tone.OK; "degraded" -> Tone.WARN; "down" -> Tone.BAD; else -> Tone.NEUTRAL
}

/** The lifecycle state, summarised from all three signals by the server. */
@Composable
fun DomainStatusPill(status: String, modifier: Modifier = Modifier) {
    CBadge(domainStatusLabel(status), domainStatusTone(status), modifier)
}

private fun isoDate(ts: Long): String =
    Instant.ofEpochMilli(ts).atZone(ZoneId.systemDefault()).toLocalDate().toString()

private fun dnsDetail(domain: Domain): String = when {
    domain.dnsVerifiedAt != null -> "Verified ${isoDate(domain.dnsVerifiedAt)}"
    domain.dnsStatus == "verified" -> "Verified"
    else -> "Awaiting record"
}

private fun sslDetail(domain: Domain): String = when {
    domain.sslExpiresAt != null -> "Expires ${isoDate(domain.sslExpiresAt)}"
    domain.sslStatus == "none" -> "No certificate yet"
    else -> "In progress"
}

private fun healthDetail(domain: Domain): String =
    if (domain.healthStatus == "unknown") "Not probed yet" else "Origin response"

@Composable
private fun SignalTile(name: String, label: String, tone: Tone, detail: String, modifier: Modifier = Modifier) {
    val colour = toneColor(tone)
    Column(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .background(Aurora.CardAlt)
            .border(1.dp, Aurora.Border, RoundedCornerShape(10.dp))
            .padding(10.dp),
    ) {
        Text(
            name.uppercase(), color = Aurora.TextLow, fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp,
        )
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(6.dp).background(colour, CircleShape))
            Spacer(Modifier.width(6.dp))
            Text(label, color = colour, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        }
        Spacer(Modifier.height(3.dp))
        Text(detail, color = Aurora.TextMid, fontSize = 11.sp, maxLines = 2)
    }
}

/** The three independent signals, side by side and never collapsed into one. */
@Composable
fun SignalTiles(domain: Domain, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        SignalTile("DNS", dnsSignalLabel(domain.dnsStatus), dnsSignalTone(domain.dnsStatus), dnsDetail(domain), Modifier.weight(1f))
        SignalTile("SSL", sslSignalLabel(domain.sslStatus), sslSignalTone(domain.sslStatus), sslDetail(domain), Modifier.weight(1f))
        SignalTile("Health", healthSignalLabel(domain.healthStatus), healthSignalTone(domain.healthStatus), healthDetail(domain), Modifier.weight(1f))
    }
}
