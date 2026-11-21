package com.mobilecloud.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.core.OperatingMode
import com.mobilecloud.work.CoreEngineProbe
import com.mobilecloud.ui.components.GlowCard
import com.mobilecloud.ui.components.IconBadge
import com.mobilecloud.ui.components.KVRow
import com.mobilecloud.ui.components.SectionLabel
import com.mobilecloud.ui.theme.Aurora

/**
 * PoR Oracle — Aurora edition (reference 7): DEGRADED banner, gold
 * VERIFICATION STATUS card with honest MISSING rows, specimen balance sheet
 * (sources A & B), Soroban attestation block. Honesty contract unchanged:
 * no reconciliation daemon ⇒ no verified ratio is claimed, ever.
 */
@Composable
fun ProofOfReserveScreen() {
    val context = LocalContext.current
    var daemonReachable by remember { mutableStateOf<Boolean?>(null) }

    LaunchedEffect(Unit) {
        daemonReachable = CoreEngineProbe.get("/api/por/attestation") != null
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Aurora.Bg)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(top = 14.dp, bottom = 96.dp),
    ) {
        ScreenHeader(
            title = "PoR Oracle",
            subtitle = "FurlPay proof-of-reserve",
            badge = "UNVERIFIED",
            badgeColor = Aurora.Amber,
            icon = Icons.Filled.CloudUpload,
        )

        Spacer(Modifier.height(12.dp))

        // ---- DEGRADED banner (ref7, red) ----
        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Red.copy(alpha = 0.45f), corner = 14.dp) {
            Column(Modifier.padding(14.dp)) {
                Row {
                    Text("MODE: ", color = Aurora.TextLow, fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                    Text(
                        if (daemonReachable == true) "DEGRADED" else "DEGRADED",
                        color = Aurora.Red, fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                    )
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    if (daemonReachable == true)
                        "Reconciliation daemon reachable, but custody evidence is unverified below. No ratio is claimed."
                    else
                        "Reconciliation daemon (127.0.0.1:3000) unreachable on this device. No verified reserves can be claimed; figures below are specimen data only.",
                    color = Aurora.TextMid, fontSize = 11.5.sp, lineHeight = 16.sp,
                )
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Verification status (gold heading, MISSING rows) ----
        GlowCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                SectionLabel("VERIFICATION STATUS", color = Aurora.Gold)
                Spacer(Modifier.height(10.dp))
                listOf(
                    "Custodian identity & ownership evidence",
                    "Liability completeness across chains",
                    "Documented token↔share conversion",
                    "Common valuation currency & timestamps",
                    "Independent attestation payload",
                ).forEach { label -> MissingRow(label) }
                Spacer(Modifier.height(10.dp))
                Box(
                    Modifier
                        .fillMaxWidth()
                        .background(Aurora.CardWell, RoundedCornerShape(10.dp))
                        .padding(10.dp)
                ) {
                    Text(
                        "Coverage ratio = verified eligible reserve value ÷ total outstanding liability value × 100. Both sides must share a valuation currency and a documented conversion — until then any % BACKED figure would be fabricated.",
                        color = Aurora.TextLow, fontSize = 10.5.sp, lineHeight = 15.sp,
                    )
                }
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Specimen balance sheet: Source A ----
        GlowCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                SectionLabel("SPECIMEN BALANCE SHEET — ILLUSTRATIVE ONLY (NOT AUDITED)")
                Spacer(Modifier.height(10.dp))
                Text("SOURCE A: ON-CHAIN TOKEN SUPPLY (specimen)", color = Aurora.TextFaint, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                Spacer(Modifier.height(6.dp))
                KVRow("Solana SPL (Backpack)", "450,000.00 ANT")
                KVRow("Robinhood Chain (L2)", "120,000.00 ANT")
                KVRow("Base L2 (Coinbase)", "60,000.00 ANT")
                KVRow("BNB Chain (bStocks)", "47,108.43 ANT")
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(vertical = 8.dp)
                        .height(1.dp)
                        .background(Aurora.Divider)
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Total On-Chain Liabilities:", color = Aurora.TextMid, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text("677,108.43 ANT", color = Aurora.TextHi, fontSize = 14.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                }
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Source B (custody, from the blueprint's PoR screen) ----
        GlowCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("SOURCE B: RESERVES / CUSTODY (specimen)", color = Aurora.TextFaint, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                Spacer(Modifier.height(6.dp))
                KVRow("DTC Settled Common Stock", "650,000.00 shares")
                KVRow("NSCC Cash in Transit (T+1)", "\$2,365,000.00")
                KVRow("Effective Transit Shares (@ \$83)", "28,500.00 shares")
                KVRow("Rehypothecated / Lent Shares", "0.00 shares", valueColor = Aurora.GlowGreen)
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(vertical = 8.dp)
                        .height(1.dp)
                        .background(Aurora.Divider)
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Net Verifiable Backing:", color = Aurora.TextMid, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text("678,500.00 shares", color = Aurora.TextHi, fontSize = 14.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                }
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Stellar Soroban attestation (specimen) ----
        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Purple.copy(alpha = 0.5f)) {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconBadge(Icons.Filled.Inventory2, Aurora.Purple, size = 28.dp, iconSize = 15.dp)
                    Spacer(Modifier.width(8.dp))
                    SectionLabel("STELLAR SOROBAN ON-CHAIN ATTESTATION", color = Aurora.TextMid)
                }
                Spacer(Modifier.height(10.dp))
                KVRow("Ledger Sequence", "#51,920,418 · committed 42s ago")
                KVRow("Canonical Digest", "0x8f2a…c014 (RFC 8785)")
                KVRow("Quorum Proof", "4-of-5 Acurast TEE signatures")
                Spacer(Modifier.height(8.dp))
                Text(
                    "SPECIMEN — no contract is referenced by this build; the attestation record above shows the format institutional verifiers will consume once the evidence chain is connected.",
                    color = Aurora.TextFaint, fontSize = 10.sp, lineHeight = 14.sp,
                )
            }
        }
    }
}

@Composable
private fun MissingRow(label: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = Aurora.TextMid, fontSize = 13.sp)
        Text("MISSING", color = Aurora.Red, fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
    }
}

@Composable
private fun ScreenHeader(
    title: String,
    subtitle: String,
    badge: String,
    badgeColor: androidx.compose.ui.graphics.Color,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column {
            Text(title, color = Aurora.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text(subtitle, color = Aurora.TextFaint, fontSize = 11.sp)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                badge,
                color = badgeColor,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.8.sp,
                modifier = Modifier
                    .background(badgeColor.copy(alpha = 0.14f), RoundedCornerShape(6.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
            Spacer(Modifier.width(8.dp))
            IconBadge(icon, badgeColor, size = 32.dp, iconSize = 16.dp)
        }
    }
}
