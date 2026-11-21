package com.mobilecloud.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.core.OperatingMode
import com.mobilecloud.ui.components.ModeBanner
import com.mobilecloud.ui.theme.*

/**
 * Screen 5: Global P2P Mesh (CIDS spec), rebuilt under the honesty layer
 * (audit prompt Phase 5).
 *
 * No WireGuard/libp2p tunnels are configured on this device — there are no
 * real peers to display. The diagram, latency reference and peer table below
 * are explicitly SPECIMEN visuals showing the intended presentation format.
 * Per the audit: private-IP placeholder tables must never be presented as
 * evidence of geographically distributed infrastructure.
 */
@Composable
fun MeshScreen() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .background(BgDark)
            .padding(16.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text("Global P2P Mesh", style = MaterialTheme.typography.titleMedium, color = TextPrimary)
            AssistChip(
                onClick = {},
                label = { Text("SIMULATED TOPOLOGY", color = Warning, fontWeight = FontWeight.Bold, fontSize = 10.sp) },
                colors = AssistChipDefaults.assistChipColors(containerColor = SurfaceElevatedDark)
            )
        }

        Spacer(modifier = Modifier.height(10.dp))

        ModeBanner(
            mode = OperatingMode.SIMULATION,
            detail = "No WireGuard/libp2p tunnels exist on this device. Everything below is specimen UI showing the format a live mesh screen will use. Peer identities, endpoints and measured RTTs will replace it.",
        )

        Spacer(modifier = Modifier.height(12.dp))

        // Specimen topology diagram.
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .height(200.dp),
            colors = CardDefaults.cardColors(containerColor = SurfaceDark),
            shape = RoundedCornerShape(12.dp)
        ) {
            Canvas(Modifier.fillMaxSize().padding(12.dp)) {
                val center = Offset(size.width / 2f, size.height / 2f)
                val peers = listOf(
                    Offset(size.width * 0.14f, size.height * 0.22f),
                    Offset(size.width * 0.86f, size.height * 0.20f),
                    Offset(size.width * 0.12f, size.height * 0.78f),
                    Offset(size.width * 0.84f, size.height * 0.80f),
                    Offset(size.width * 0.5f, size.height * 0.08f),
                )
                peers.forEach { peer ->
                    drawLine(
                        color = PrimaryCyan.copy(alpha = 0.45f),
                        start = center, end = peer,
                        strokeWidth = 2f, cap = StrokeCap.Round,
                    )
                }
                peers.forEach { peer ->
                    drawCircle(color = TextSecondary.copy(alpha = 0.7f), radius = 9f, center = peer)
                }
                drawCircle(color = PrimaryCyan, radius = 16f, center = center)
                drawCircle(color = Background, radius = 8f, center = center)
            }
        }
        Text(
            "specimen diagram — not an active network",
            color = TextSecondary, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
            modifier = Modifier.padding(top = 4.dp)
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Regional RTT reference — clearly NOT measurements.
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = SurfaceDark),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("REGIONAL RTT REFERENCE (TYPICAL VALUES — NOT MEASURED HERE)", color = TextSecondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(8.dp))
                LatencyRow("us-east (typical)", "12 ms", SuccessEmerald, 0.10f)
                LatencyRow("eu-central (typical)", "84 ms", PrimaryCyan, 0.45f)
                LatencyRow("ap-northeast (typical)", "98 ms", PrimaryCyan, 0.55f)
                LatencyRow("ap-south (typical)", "112 ms", WarnAmber, 0.68f)
                LatencyRow("eu-west relay (typical)", "38 ms", SuccessEmerald, 0.22f)
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    "Real per-peer RTT/handshake/loss columns replace this table once WireGuard peers are provisioned.",
                    color = TextSecondary, fontSize = 10.sp
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Specimen peer table — private IPs, labeled as placeholders.
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = SurfaceDark),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("SPECIMEN PEER TABLE (PLACEHOLDER VPN PLAN — NO LIVE CONNECTIONS)", color = TextSecondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(8.dp))
                PeerRow("node-us-west-402 (this)", "10.42.0.1", "PLANNED")
                PeerRow("node-eu-fra-217", "10.42.0.2", "PLANNED")
                PeerRow("node-ap-sgp-088", "10.42.0.3", "PLANNED")
                PeerRow("node-us-ash-771", "10.42.0.4", "PLANNED")
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    "Private 10.42.0.0/24 addresses are internal VPN-plan placeholders. They demonstrate nothing about remote infrastructure existence or location.",
                    color = TextSecondary, fontSize = 10.sp
                )
            }
        }
    }
}

@Composable
private fun LatencyRow(region: String, latency: String, color: Color, barFraction: Float) {
    Column(modifier = Modifier.padding(vertical = 4.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(region, color = TextSecondary, fontSize = 13.sp)
            Text(latency, color = color, fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(4.dp)
                .background(SurfaceElevatedDark, RoundedCornerShape(2.dp))
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(barFraction)
                    .height(4.dp)
                    .background(color, RoundedCornerShape(2.dp))
            )
        }
    }
}

@Composable
private fun PeerRow(name: String, ip: String, role: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(name, color = TextPrimary, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        Text(ip, color = TextSecondary, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        Text(role, color = AccentIndigo, fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}
