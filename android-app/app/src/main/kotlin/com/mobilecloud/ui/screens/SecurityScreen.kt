package com.mobilecloud.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.security.AppLockManager
import com.mobilecloud.security.HardwareAttestation
import com.mobilecloud.ui.components.GlowCard
import com.mobilecloud.ui.components.IconBadge
import com.mobilecloud.ui.components.RefSourceChip
import com.mobilecloud.ui.components.SectionLabel
import com.mobilecloud.ui.components.StatusPill
import com.mobilecloud.ui.theme.Aurora
import androidx.compose.ui.platform.LocalContext

/**
 * Security tab from the node console: hardware key, biometric gate, and the
 * mesh cluster. Mesh peers stay inside this tab so the reference four-item
 * bar (Dashboard, Security, CloudShell, Settings) still reaches them.
 */
@Composable
fun SecurityScreen() {
    val context = LocalContext.current
    var showMesh by remember { mutableStateOf(false) }
    var keystore by remember {
        mutableStateOf(HardwareAttestation.Result("…", "-", "-", "probing AndroidKeyStore"))
    }
    LaunchedEffect(Unit) { keystore = HardwareAttestation.ensureIdentityKey() }

    if (showMesh) {
        Column(Modifier.fillMaxSize().background(Aurora.Bg)) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "← Security",
                    color = Aurora.Cyan,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.clickable { showMesh = false },
                )
            }
            MeshScreen()
        }
        return
    }

    val lockOn = AppLockManager.isEnabled(context)
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Aurora.Bg)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(top = 14.dp, bottom = 96.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Column {
                Text("Security", color = Aurora.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp)
                Text("StrongBox, app lock, mesh", color = Aurora.TextMid, fontSize = 11.sp)
            }
            IconBadge(Icons.Filled.Shield, Aurora.Cyan, size = 34.dp, iconSize = 18.dp)
        }
        Spacer(Modifier.height(14.dp))

        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Cyan, corner = 12.dp) {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconBadge(Icons.Filled.VerifiedUser, Aurora.Cyan, size = 28.dp, iconSize = 16.dp)
                    Spacer(Modifier.width(8.dp))
                    SectionLabel("DEVICE TRUST")
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    keystore.securityLevel,
                    color = when (keystore.securityLevel) {
                        "STRONGBOX" -> Aurora.GlowGreen
                        "TEE" -> Aurora.Cyan
                        else -> Aurora.Amber
                    },
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
                Spacer(Modifier.height(6.dp))
                Text(keystore.detail, color = Aurora.TextMid, fontSize = 11.sp, lineHeight = 15.sp)
                Spacer(Modifier.height(8.dp))
                RefSourceChip("AndroidKeyStore")
            }
        }

        Spacer(Modifier.height(12.dp))

        GlowCard(Modifier.fillMaxWidth(), glow = Aurora.Border, corner = 12.dp) {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconBadge(Icons.Filled.Key, Aurora.Cyan, size = 28.dp, iconSize = 15.dp)
                    Spacer(Modifier.width(8.dp))
                    SectionLabel("HARDWARE KEY")
                }
                Spacer(Modifier.height(10.dp))
                Text("Algorithm  ${keystore.keyAlgorithm}", color = Aurora.TextMid, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                Text(
                    "SHA-256  ${keystore.publicKeySha256.take(24)}…",
                    color = Aurora.Cyan,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                )
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = { keystore = HardwareAttestation.rotateKey() },
                    modifier = Modifier.fillMaxWidth().height(40.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Aurora.CardAlt),
                    shape = RoundedCornerShape(8.dp),
                ) { Text("Rotate hardware key", color = Aurora.TextHi, fontWeight = FontWeight.SemiBold, fontSize = 13.sp) }
            }
        }

        Spacer(Modifier.height(12.dp))

        GlowCard(Modifier.fillMaxWidth(), corner = 12.dp) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                IconBadge(Icons.Filled.Fingerprint, Aurora.Cyan, size = 28.dp, iconSize = 16.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text("Biometric app lock", color = Aurora.TextHi, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    Text(
                        if (lockOn) "Gate re-arms after the app is backgrounded" else "Lock is off on this device",
                        color = Aurora.TextMid,
                        fontSize = 11.sp,
                    )
                }
                StatusPill(if (lockOn) "On" else "Off", color = if (lockOn) Aurora.GlowGreen else Aurora.Amber)
            }
        }

        Spacer(Modifier.height(12.dp))

        GlowCard(Modifier.fillMaxWidth().clickable { showMesh = true }, glow = Aurora.Border, corner = 12.dp) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                IconBadge(Icons.Filled.Hub, Aurora.Cyan, size = 28.dp, iconSize = 16.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text("Mesh cluster", color = Aurora.TextHi, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    Text("WireGuard overlay peers and path health", color = Aurora.TextMid, fontSize = 11.sp)
                }
                Box(Modifier.size(8.dp).clip(CircleShape).background(Aurora.GlowGreen))
            }
        }
    }
}
