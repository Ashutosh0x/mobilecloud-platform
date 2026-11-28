package com.mobilecloud.ui.console.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.console.Domain
import com.mobilecloud.ui.console.BtnKind
import com.mobilecloud.ui.console.CButton
import com.mobilecloud.ui.console.CHairline
import com.mobilecloud.ui.console.CNotice
import com.mobilecloud.ui.console.Hint
import com.mobilecloud.ui.console.Mono
import com.mobilecloud.ui.console.Tone
import com.mobilecloud.ui.theme.Aurora

/* =========================================================================
 * DNS INSTRUCTION CARD — the records an operator must publish, exactly as the
 * server verifies them. Ported from the web `DomainDnsCard.tsx`.
 * ========================================================================= */

private val HOST_LABEL = Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
private val RESERVED_SUFFIXES =
    listOf(".local", ".localhost", ".internal", ".test", ".invalid", ".example", ".home", ".lan", ".onion")

/** Strips a scheme, path, port or wildcard prefix from a pasted value. */
fun normalizeHost(raw: String): String = raw.trim().lowercase()
    .replace(Regex("^[a-z][a-z0-9+.-]*://"), "")
    .replace(Regex("[/?#].*$"), "")
    .replace(Regex(":\\d+$"), "")
    .replace(Regex("^\\*\\."), "")
    .trim('.')

/**
 * Fast, inline mirror of the server's `domain-validation.ts`. The server
 * re-validates every hostname before storing it, so this exists only to give
 * feedback without a round-trip — never as the authority.
 */
fun hostValidationMessage(raw: String, existing: List<String>): String? {
    if (raw.isBlank()) return null
    val host = normalizeHost(raw)
    if (host.isEmpty()) return "Enter a hostname like app.example.com."
    if (host.length > 253) return "A hostname cannot be longer than 253 characters."
    if (host.contains(" ")) return "A hostname cannot contain spaces."
    val labels = host.split(".")
    if (labels.size < 2) return "Enter a full hostname like app.example.com."
    for (label in labels) {
        if (label.isEmpty()) return "A hostname cannot contain an empty label."
        if (label.length > 63) return "Each part must be 63 characters or fewer."
        if (!HOST_LABEL.matches(label)) return "Use letters, digits and hyphens only, and do not start or end a part with a hyphen."
    }
    if (!Regex("^[a-z]{2,}$").matches(labels.last())) return "Enter a hostname with a valid public suffix, like .com."
    if (host == "localhost" || host == "local" || RESERVED_SUFFIXES.any { host == it.drop(1) || host.endsWith(it) }) {
        return "That hostname is reserved and cannot be configured."
    }
    if (existing.any { normalizeHost(it) == host }) return "$host is already configured on this account."
    return null
}

data class DnsRecordLine(val type: String, val name: String, val value: String)

/** The records an operator must publish, exactly as verification checks them. */
fun dnsRecords(domain: Domain): List<DnsRecordLine> {
    val out = mutableListOf<DnsRecordLine>()
    domain.tunnelTarget?.let { out += DnsRecordLine("CNAME", domain.host, it) }
    domain.verificationToken?.let { out += DnsRecordLine("TXT", "_mobilecloud-verify.${domain.host}", it) }
    return out
}

@Composable
fun DnsCard(
    domain: Domain,
    onVerify: () -> Unit,
    verifying: Boolean,
    onCopied: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val clipboard = LocalClipboardManager.current
    val records = dnsRecords(domain)
    val verified = domain.dnsStatus == "verified"
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Aurora.CardAlt)
            .border(1.dp, Aurora.Border, RoundedCornerShape(12.dp))
            .padding(14.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Configure DNS", color = Aurora.TextHi, fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f),
            )
            DomainStatusPill(domain.status)
        }

        domain.lastError?.let {
            Spacer(Modifier.height(8.dp))
            CNotice(it.message, Tone.BAD)
        }

        Spacer(Modifier.height(8.dp))
        if (records.isEmpty()) {
            CNotice(
                "This deployment has not published a tunnel target yet, so the CNAME value is not known. " +
                    "Ask your operator to set CLOUDFLARE_TUNNEL_ID, then reopen this page.",
                Tone.WARN,
            )
        } else {
            records.forEach { record ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("${record.type} · ${record.name}", color = Aurora.TextLow, fontSize = 11.sp, maxLines = 1)
                        Spacer(Modifier.height(2.dp))
                        Mono(record.value, color = Aurora.TextHi, size = 12, maxLines = 2)
                    }
                    Spacer(Modifier.width(8.dp))
                    CButton(
                        "Copy",
                        onClick = {
                            clipboard.setText(AnnotatedString(record.value))
                            onCopied("${record.type} ${record.name} copied.")
                        },
                        kind = BtnKind.GHOST,
                        compact = true,
                    )
                }
                CHairline()
            }
        }

        Spacer(Modifier.height(10.dp))
        Hint("DNS changes can take time to propagate. Verification re-checks the live records — nothing is marked verified until the record actually matches.")
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            CButton(if (verified) "Re-check DNS" else "Verify DNS", onClick = onVerify, loading = verifying, compact = true)
            Spacer(Modifier.width(10.dp))
            Text(
                if (verified) "DNS verified." else domain.detail,
                color = Aurora.TextMid, fontSize = 11.sp, modifier = Modifier.weight(1f),
            )
        }
    }
}
