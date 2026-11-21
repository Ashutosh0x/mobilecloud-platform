package com.mobilecloud.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.AppDirs
import com.mobilecloud.terminal.NativePtyController
import com.mobilecloud.terminal.TerminalEmulator
import com.mobilecloud.terminal.TerminalSurfaceView
import com.mobilecloud.ui.components.SpecialKey
import com.mobilecloud.ui.components.VirtualKeyBar
import com.mobilecloud.ui.theme.*

/**
 * Screen 4: Inbuilt CloudShell & PTY Terminal (CIDS spec; terminal doc).
 *
 * A real Unix PTY session via forkpty (libmobilecloud_native.so) rendered
 * through the Compose VT100 canvas, with the touch-optimized virtual
 * accessory bar (CTRL sticky, ESC, TAB, pipe, arrows).
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
            SpecialKey.Tab -> send("\t")
            SpecialKey.Up -> send("\u001b[A")
            SpecialKey.Down -> send("\u001b[B")
            SpecialKey.Left -> send("\u001b[D")
            SpecialKey.Right -> send("\u001b[C")
            is SpecialKey.CtrlChar -> send((key.ch.code and 0x1F).toChar().toString())
            is SpecialKey.AltChar -> send("\u001b" + key.ch)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF030712))
            .padding(12.dp)
    ) {
        // Session tab bar.
        Row(modifier = Modifier.fillMaxWidth()) {
            AssistChip(
                onClick = {},
                label = { Text(if (connected) "Session 1: /dev/pts (LIVE)" else "Session 1: starting…", color = if (connected) PrimaryCyan else TextSecondary) },
                colors = AssistChipDefaults.assistChipColors(containerColor = SurfaceDark)
            )
            Spacer(modifier = Modifier.width(8.dp))
            AssistChip(
                onClick = {},
                label = { Text("por-kernel logs", color = TextSecondary) },
                colors = AssistChipDefaults.assistChipColors(containerColor = SurfaceElevatedDark)
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Terminal canvas (real PTY bytes).
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .background(Color.Black, shape = RoundedCornerShape(8.dp))
                .padding(8.dp)
        ) {
            TerminalSurfaceView(
                emulator = emulator,
                modifier = Modifier.fillMaxSize(),
                onTap = { connected = pty.isAlive },
            )
        }

        Spacer(modifier = Modifier.height(6.dp))

        // IME capture field: enter text, Enter sends the line.
        OutlinedTextField(
            value = inputBuffer,
            onValueChange = { inputBuffer = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("type a command…", color = TextSecondary, fontSize = 12.sp) },
            textStyle = androidx.compose.ui.text.TextStyle(
                color = TerminalGreen,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
            ),
            singleLine = true,
            trailingIcon = {
                TextButton(onClick = {
                    send(inputBuffer + "\n")
                    inputBuffer = ""
                }) { Text("⏎", color = PrimaryCyan) }
            },
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = PrimaryCyan,
                cursorColor = PrimaryCyan,
            ),
        )

        Spacer(modifier = Modifier.height(6.dp))

        // Virtual accessory bar: ESC / TAB / CTRL / ALT / pipe / arrows.
        VirtualKeyBar(
            onKey = { ch -> send(ch) },
            onSpecial = ::onSpecial,
        )
    }
}
