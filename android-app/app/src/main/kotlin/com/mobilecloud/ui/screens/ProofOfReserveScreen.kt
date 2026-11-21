package com.mobilecloud.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.core.OperatingMode
import com.mobilecloud.ui.components.ModeBanner
import com.mobilecloud.ui.theme.*
import com.mobilecloud.work.CoreEngineProbe

/**
 * Screen 3: Proof-of-Reserve Oracle (CIDS spec), rebuilt under the honesty
 * layer (audit prompt Phase 4).
 *
 * No reconciliation source is connected in this build: the por-kernel daemon
 * (127.0.0.1:3000) is not running on this device, no custody statements are
 * ingested, and no Soroban contract is referenced. Therefore the screen
 * reports UNVERIFIED — the specimen balance sheet below exists only to show
 * the presentation format, and it deliberately includes the methodology
 * caveat from the audit: shares vs tokens are different units and a coverage
 * ratio requires a documented conversion + common valuation currency.
 */
@Composable
fun ProofOfReserveScreen() {
    val context = LocalContext.current
    var daemonReachable by remember { mutableStateOf<Boolean?>(null) }

    // Probe the reconciliation daemon once; result decides LIVE vs DEGRADED.
    LaunchedEffect(Unit) {
        daemonReachable = CoreEngineProbe.get("/api/por/attestation") != null
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .background(BgDark)
            .padding(16.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("Proof-of-Reserve Oracle", style = MaterialTheme.typography.titleMedium, color = TextPrimary)
            AssistChip(
                onClick = {},
                label = { Text("UNVERIFIED", color = Warning, fontWeight = FontWeight.Bold, fontSize = 10.sp) },
                colors = AssistChipDefaults.assistChipColors(containerColor = SurfaceElevatedDark)
            )
        }

        Spacer(modifier = Modifier.height(10.dp))

        ModeBanner(
            mode = if (daemonReachable == true) OperatingMode.DEGRADED else OperatingMode.DEGRADED,
            detail = if (daemonReachable == true)
                "por-kernel daemon reachable — data below still requires custody-evidence verification before any ratio is claimed."
            else
                "Reconciliation daemon (127.0.0.1:3000) unreachable on this device. No verified reserves can be claimed; figures below are specimen data only.",
        )

        Spacer(modifier = Modifier.height(12.dp))

        // Methodology gap card — the honest accounting statement.
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = SurfaceDark),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("VERIFICATION STATUS", color = Warning, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(6.dp))
                MethodRow("Custodian identity & ownership evidence", false)
                MethodRow("Liability completeness across chains", false)
                MethodRow("Documented token↔share conversion", false)
                MethodRow("Common valuation currency & timestamps", false)
                MethodRow("Independent attestation payload", false)
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    "Coverage ratio = verified eligible reserve value ÷ total outstanding liability value × 100. Both sides must share a valuation currency and a documented conversion — until then any % BACKED figure would be fabricated.",
                    color = TextSecondary, fontSize = 11.sp
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Specimen balance sheet (format illustration only).
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = SurfaceDark),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("SPECIMEN BALANCE SHEET — ILLUSTRATIVE ONLY (NOT AUDITED)", color = TextSecondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(8.dp))
                Text("SOURCE A: ON-CHAIN TOKEN SUPPLY (specimen)", color = TextSecondary, fontSize = 10.sp)
                Spacer(modifier = Modifier.height(4.dp))
                TokenSupplyRow("Solana SPL (Backpack)", "450,000.00 ANT")
                TokenSupplyRow("Robinhood Chain (L2)", "120,000.00 ANT")
                TokenSupplyRow("Base L2 (Coinbase)", "60,000.00 ANT")
                TokenSupplyRow("BNB Chain (bStocks)", "47,108.43 ANT")
                Divider(color = SurfaceElevatedDark, modifier = Modifier.padding(vertical = 8.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Total On-Chain Liabilities:", color = TextSecondary, fontWeight = FontWeight.Medium)
                    Text("677,108.43 ANT", color = TextPrimary, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = SurfaceDark),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("SOURCE B: DTC PHYSICAL CUSTODY & T+1 (specimen)", color = TextSecondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(8.dp))
                TokenSupplyRow("DTC Settled Shares", "650,000.00 Shares")
                TokenSupplyRow("NSCC Transit Cash (T+1)", "$2,365,000.00 USD")
                TokenSupplyRow("Effective Transit Shares", "28,500.00 Shares")
                Divider(color = SurfaceElevatedDark, modifier = Modifier.padding(vertical = 8.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Net Backing (specimen):", color = TextSecondary, fontWeight = FontWeight.Medium)
                    Text("678,500.00 Shares", color = TextPrimary, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                }
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    "⚠ Units differ: ANT tokens ≠ shares. A ratio from these two totals is NOT valid without a documented conversion.",
                    color = Warning, fontSize = 11.sp
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Attestation — honestly absent.
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = SurfaceDark),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("STELLAR SOROBAN ATTESTATION", color = TextSecondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(6.dp))
                Text("No contract address configured", color = TextPrimary, fontSize = 12.sp)
                Text("No transaction hashes — nothing to verify", color = TextSecondary, fontSize = 12.sp)
                Text("No TEE quorum payload — SPECIMEN placeholder only", color = TextSecondary, fontSize = 12.sp)
                Text(
                    "RFC 8785 canonicalization is implemented in por-kernel for evidence hashing, but displaying a digest proves nothing without a verifiable payload + signature set.",
                    color = TextSecondary, fontSize = 10.sp
                )
            }
        }
    }
}

@Composable
private fun MethodRow(item: String, verified: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(item, color = TextPrimary, fontSize = 12.sp)
        Text(
            if (verified) "VERIFIED" else "MISSING",
            color = if (verified) Success else Critical,
            fontSize = 11.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace
        )
    }
}

@Composable
fun TokenSupplyRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, color = TextSecondary, fontSize = 13.sp)
        Text(value, color = TextPrimary, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
    }
}
