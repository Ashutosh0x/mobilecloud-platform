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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.AppDirs
import com.mobilecloud.terminal.NativePtyController
import com.mobilecloud.terminal.TerminalEmulator
import com.mobilecloud.terminal.TerminalSurfaceView
import com.mobilecloud.ui.components.GlowCard
import com.mobilecloud.ui.components.SpecialKey
import com.mobilecloud.ui.components.VirtualKeyBar
import com.mobilecloud.ui.theme.Aurora

/**
 * CloudShell — Aurora edition (reference 5): session chip row with traffic
 * dots, deep-well terminal canvas over the REAL forkpty PTY stream, bordered
 * command input with ⏎, and the touch key bar. Zero PTY logic changed.
 */
@Composable
fun CloudShellScreen() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val emulator = remember { TerminalEmulator(cols = 80, rows = 24) }
    val pty = remember {
        NativePtyController(
            engineBin = AppDirs.engineBin(context),
            home = AppDirs.homeDir(context),
        )
    }
    var connected by remember { mutableStateOf(false) }
    var inputBuffer by remember { mutableStateOf("") }

    DisposableEffect(Unit) {
        pty.onOutput = { chunk -> emulator.feed(chunk) }
        pty.onExit = { connected = false }
        pty.start()
        connected = pty.isAlive
        onDispose { pty.close() }
    }

    fun send(raw: String) {
        pty.write(raw)
    }

    fun onSpecial(key: SpecialKey) {
        when (key) {
            SpecialKey.Esc -> send("\u001b")
            SpecialKey.Tab -> send("	")
            SpecialKey.Up -> send("\u001b[A")
            SpecialKey.Down -> send("[B")
            SpecialKey.Left -> send("[D")
            SpecialKey.Right -> send("[C")
            is SpecialKey.CtrlChar -> send((key.ch.code and 0x1F).toChar().toString())
            is SpecialKey.AltChar -> send("\u001b" + key.ch)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Aurora.Bg)
            .padding(horizontal = 12.dp)
            .padding(top = 12.dp, bottom = 96.dp),
    ) {
        // ---- Session bar (ref5 chrome) ----
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.Terminal, null,
                    tint = if (connected) Aurora.GlowGreen else Aurora.TextLow,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    if (connected) "Session 1 · /dev/pts (LIVE)" else "Session 1 · starting…",
                    color = if (connected) Aurora.TextHi else Aurora.TextLow,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    fontFamily = FontFamily.Monospace,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(7.dp).background(if (connected) Aurora.GlowGreen else Aurora.Amber, CircleShape))
                Spacer(Modifier.width(5.dp))
                Text(
                    if (connected) "PTY alive" else "connecting",
                    color = Aurora.TextFaint, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                )
            }
        }

        Spacer(Modifier.height(9.dp))

        // ---- Terminal well (real PTY bytes) ----
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(Color(0xFF050A16))
                .padding(9.dp)
        ) {
            TerminalSurfaceView(
                emulator = emulator,
                modifier = Modifier.fillMaxSize(),
                onTap = { connected = pty.isAlive },
            )
        }

        Spacer(Modifier.height(9.dp))

        // ---- Command input (ref5 bordered bar + ⏎) ----
        GlowCard(Modifier.fillMaxWidth(), corner = 13.dp, background = Aurora.CardAlt) {
            OutlinedTextField(
                value = inputBuffer,
                onValueChange = { inputBuffer = it },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
                placeholder = { Text("type a command…", color = Aurora.TextFaint, fontSize = 12.sp) },
                textStyle = TextStyle(
                    color = Aurora.GlowGreen,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                ),
                singleLine = true,
                trailingIcon = {
                    TextButton(onClick = {
                        send(inputBuffer + "\n")
                        inputBuffer = ""
                    }) { Text("⏎", color = Aurora.Cyan, fontWeight = FontWeight.Bold) }
                },
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Aurora.Cyan.copy(alpha = 0.6f),
                    unfocusedBorderColor = Aurora.Border,
                    cursorColor = Aurora.Cyan,
                ),
            )
        }

        Spacer(Modifier.height(8.dp))

        // ---- Virtual accessory bar (unchanged real wiring) ----
        VirtualKeyBar(
            onKey = { ch -> send(ch) },
            onSpecial = ::onSpecial,
        )
    }
}
