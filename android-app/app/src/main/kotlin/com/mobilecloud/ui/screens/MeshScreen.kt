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
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.ui.components.GlowCard
import com.mobilecloud.ui.components.IconBadge
import com.mobilecloud.ui.components.KVRow
import com.mobilecloud.ui.components.LinearMeter
import com.mobilecloud.ui.components.MeshTopology
import com.mobilecloud.ui.components.SectionLabel
import com.mobilecloud.ui.components.StatusPill
import com.mobilecloud.ui.theme.Aurora

/**
 * Mesh — Aurora edition (reference 6): SIMULATION banner, animated hub-and-
 * spoke topology canvas, color-graded RTT reference bars, specimen peer
 * table, failover policy card. Honesty contract unchanged: no tunnels exist
 * on this device; everything is labelled specimen/typical, never measured.
 */
@Composable
fun MeshScreen() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Aurora.Bg)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(top = 14.dp, bottom = 96.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text("Mesh", color = Aurora.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp)
                Text("Global P2P topology", color = Aurora.TextMid, fontSize = 11.sp)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusPill("SIMULATED", color = Aurora.Amber)
                Spacer(Modifier.width(8.dp))
                IconBadge(Icons.Filled.Hub, Aurora.Cyan, size = 32.dp, iconSize = 16.dp)
            }
        }

        Spacer(Modifier.height(12.dp))

        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Border, corner = 12.dp) {
            Column(Modifier.padding(14.dp)) {
                Row {
                    Text("MODE: ", color = Aurora.TextLow, fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                    Text("SIMULATION", color = Aurora.Amber, fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    "No WireGuard/libp2p tunnels exist on this device. Everything below is specimen UI showing the format a live mesh screen will use. Peer identities, endpoints and measured RTTs will replace it.",
                    color = Aurora.TextMid, fontSize = 11.5.sp, lineHeight = 16.sp,
                )
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Animated topology (ref6) ----
        GlowCard(Modifier.fillMaxWidth(), corner = 12.dp) {
            Column(Modifier.padding(10.dp)) {
                MeshTopology(
                    modifier = Modifier.fillMaxWidth().height(210.dp),
                    peers = 5,
                )
            }
        }
        Text(
            "specimen diagram — not an active network",
            color = Aurora.TextFaint,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 6.dp),
        )

        Spacer(Modifier.height(11.dp))

        // ---- RTT reference bars (ref6, color-graded) ----
        GlowCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                SectionLabel("REGIONAL RTT REFERENCE (TYPICAL VALUES — NOT MEASURED HERE)")
                Spacer(Modifier.height(12.dp))
                RttBar("us-east (typical)", 12, Aurora.GlowGreen)
                RttBar("eu-central (typical)", 84, Aurora.Cyan)
                RttBar("ap-northeast (typical)", 98, Aurora.Cyan)
                RttBar("ap-south (typical)", 112, Aurora.Amber)
                RttBar("eu-west relay (typical)", 38, Aurora.GlowGreen)
                Spacer(Modifier.height(10.dp))
                Text(
                    "Real per-peer RTT/handshake/loss columns replace this table once WireGuard peers are provisioned.",
                    color = Aurora.TextFaint, fontSize = 10.5.sp, lineHeight = 14.sp,
                )
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Specimen peer table ----
        GlowCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                SectionLabel("SPECIMEN PEER TABLE (PLACEHOLDER VPN PLAN — NO LIVE TUNNELS)")
                Spacer(Modifier.height(8.dp))
                PeerRow("01-Ashburn-Solana-Prime", "12.4 ms", "Direct 5G-UWB", Aurora.GlowGreen)
                PeerRow("02-Frankfurt-Jito-Engine", "84.1 ms", "WireGuard-EU", Aurora.Cyan)
                PeerRow("03-Tokyo-Validator-Node", "98.6 ms", "WireGuard-AP", Aurora.Cyan)
                PeerRow("04-Mumbai-Edge-Relay", "112.0 ms", "WireGuard-IN", Aurora.Amber)
            }
        }

        Spacer(Modifier.height(13.dp))

        // ---- Failover policy ----
        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Blue.copy(alpha = 0.45f)) {
            Column(Modifier.padding(16.dp)) {
                SectionLabel("DATA ROUTING FAILOVER POLICY")
                Spacer(Modifier.height(8.dp))
                KVRow("Primary · Wi-Fi 7 (802.11be)", "CONNECTED", valueColor = Aurora.GlowGreen)
                KVRow("Secondary · 5G SA Dual-SIM", "STANDBY", valueColor = Aurora.TextLow)
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(8.dp).background(Aurora.GlowGreen, CircleShape)
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "QUIC connection migration keeps tunnels alive across Wi-Fi ↔ cellular handovers",
                        color = Aurora.TextFaint, fontSize = 10.5.sp,
                    )
                }
            }
        }
    }
}

@Composable
private fun RttBar(label: String, ms: Int, color: Color) {
    Column(Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, color = Aurora.TextMid, fontSize = 13.sp)
            Text(
                "$ms ms",
                color = color,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
        Spacer(Modifier.height(5.dp))
        LinearMeter(progress = (ms / 130f).coerceIn(0.05f, 1f), color = color, height = 5.dp)
    }
}

@Composable
private fun PeerRow(name: String, rtt: String, route: String, color: Color) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).background(color, CircleShape))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(name, color = Aurora.TextHi, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
            Text(route, color = Aurora.TextFaint, fontSize = 10.sp)
        }
        Text(rtt, color = color, fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
    }
}
