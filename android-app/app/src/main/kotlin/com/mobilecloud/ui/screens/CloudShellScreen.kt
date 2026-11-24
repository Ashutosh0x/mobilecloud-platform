package com.mobilecloud.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobilecloud.AppDirs
import com.mobilecloud.terminal.NativePtyController
import com.mobilecloud.terminal.TerminalEmulator
import com.mobilecloud.terminal.TerminalSessionService
import com.mobilecloud.terminal.TerminalSurfaceView
import com.mobilecloud.ui.components.VirtualKeyBar
import com.mobilecloud.ui.theme.AppFonts
import com.mobilecloud.ui.theme.Aurora

/**
 * CloudShell — the real on-device terminal.
 *
 * Wires [TerminalSurfaceView] to [NativePtyController]: keystrokes go into a
 * real forkpty slave, PTY bytes feed a VT/xterm engine with scrollback and
 * alternate-screen support, and resizes dispatch `SIGWINCH`. With a bundled
 * `tmux`, leaving this screen detaches the client while the session keeps
 * running, so returning reattaches instead of restarting the shell.
 *
 * The fake fixed-command `ShellPage` is still reachable from the web console
 * route table, but `/shell` in the app now lands here (see ConsoleRoutes).
 */
@Composable
fun CloudShellScreen(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current

    val emulator = remember {
        TerminalEmulator(cols = 80, rows = 24, scrollbackLimit = 10_000)
    }

    // Bumping this rebuilds the PTY client (restart after an exited shell)
    // without discarding the emulator's scrollback.
    var generation by remember { mutableIntStateOf(0) }
    val pty = remember(generation) {
        NativePtyController(
            engineBin = AppDirs.engineBin(context),
            home = AppDirs.homeDir(context),
        )
    }

    var connected by remember(generation) { mutableStateOf(false) }
    var title by remember { mutableStateOf<String?>(null) }
    var scrolledBack by remember { mutableStateOf(false) }
    var keepAlive by remember { mutableStateOf(TerminalSessionService.isRunning) }

    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val clipboard = remember(context) {
        context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    }

    fun send(raw: String) {
        if (raw.isEmpty()) return
        emulator.scrollToBottom()
        pty.write(raw)
    }

    fun writeClipboard(text: String) {
        runCatching {
            clipboard?.setPrimaryClip(ClipData.newPlainText("CloudShell", text))
        }
    }

    fun readClipboard(): String? = runCatching {
        clipboard?.primaryClip
            ?.takeIf { it.itemCount > 0 }
            ?.getItemAt(0)
            ?.coerceToText(context)
            ?.toString()
    }.getOrNull()

    DisposableEffect(pty) {
        pty.onOutput = { chunk -> emulator.feed(chunk) }
        pty.onExit = { connected = false }
        pty.start()
        connected = pty.isAlive
        onDispose {
            pty.onOutput = null
            pty.onExit = null
            pty.close()
        }
    }

    DisposableEffect(emulator) {
        emulator.onTitle = { value -> title = value.takeIf { it.isNotBlank() } }
        emulator.onBell = { haptics.performHapticFeedback(HapticFeedbackType.LongPress) }
        onDispose {
            emulator.onTitle = null
            emulator.onBell = null
        }
    }

    val status = when {
        !connected -> "exited"
        pty.usingTmux -> "tmux · live"
        else -> "pty · live"
    }
    val statusTone = if (connected) Aurora.GlowGreen else Aurora.Amber

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(Aurora.Bg)
            .padding(horizontal = 10.dp)
            .padding(top = 8.dp, bottom = 78.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                Icon(
                    Icons.Filled.Terminal,
                    contentDescription = null,
                    tint = if (connected) Aurora.GlowGreen else Aurora.TextLow,
                    modifier = Modifier.size(15.dp),
                )
                Spacer(Modifier.width(7.dp))
                Text(
                    title ?: "CloudShell",
                    color = if (connected) Aurora.TextHi else Aurora.TextLow,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    fontFamily = AppFonts.Mono,
                    maxLines = 1,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(7.dp).background(statusTone, CircleShape))
                Spacer(Modifier.width(5.dp))
                Text(
                    status,
                    color = Aurora.TextFaint,
                    fontSize = 10.sp,
                    fontFamily = AppFonts.Mono,
                )
            }
        }

        Spacer(Modifier.height(7.dp))

        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0xFF070A13))
                .border(1.dp, Aurora.Border, RoundedCornerShape(12.dp)),
        ) {
            TerminalSurfaceView(
                emulator = emulator,
                modifier = Modifier.fillMaxSize().padding(6.dp),
                fontSize = 13.sp,
                focusRequester = focusRequester,
                onResize = { cols, rows -> pty.resize(rows, cols) },
                onInput = { send(it) },
                onClipboard = { writeClipboard(it) },
                onClipboardRead = { readClipboard() },
                onScrollState = { scrolledBack = it },
                onTap = { connected = pty.isAlive },
            )

            if (scrolledBack) {
                // Termux-style "jump to live" affordance while reading history.
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(10.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(Aurora.Cyan.copy(alpha = 0.22f))
                        .border(1.dp, Aurora.Cyan, RoundedCornerShape(999.dp))
                        .clickable { emulator.scrollToBottom() }
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                ) {
                    Text("↓ LIVE", color = Aurora.Cyan, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                }
            }
        }

        Spacer(Modifier.height(7.dp))

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TermAction("⌨") {
                runCatching { focusRequester.requestFocus() }
                keyboard?.show()
            }
            TermAction("PASTE") {
                val text = readClipboard()
                if (!text.isNullOrEmpty()) send(emulator.paste(text))
            }
            TermAction("CLR") {
                send("\u000c")
                emulator.resetScrollback()
            }
            TermAction("↑ TOP") { emulator.scrollViewport(emulator.scrollbackSize) }
            Spacer(Modifier.weight(1f))
            if (!connected) {
                TermAction("↺ RESTART", accent = true) {
                    generation += 1
                }
            } else {
                // Pin the session (and the tmux server behind it) so a build
                // survives Doze and a backgrounded app.
                TermAction(
                    label = if (keepAlive) "⏻ KEEP ON" else "⏻ KEEP",
                    accent = keepAlive,
                ) {
                    keepAlive = TerminalSessionService.toggle(context, title ?: "CloudShell")
                }
            }
        }

        Spacer(Modifier.height(5.dp))

        VirtualKeyBar(
            onKey = { send(it) },
            onNamed = { key, modifiers -> send(emulator.encodeKey(key, modifiers)) },
        )
    }
}

/** Compact terminal-toolbar button; the accessory bar owns the bigger caps. */
@Composable
private fun TermAction(
    label: String,
    accent: Boolean = false,
    onClick: () -> Unit,
) {
    val color = if (accent) Aurora.Cyan else Aurora.TextMid
    Box(
        modifier = Modifier
            .height(30.dp)
            .clip(RoundedCornerShape(7.dp))
            .background(Aurora.CardAlt)
            .border(1.dp, if (accent) Aurora.Cyan else Aurora.Border, RoundedCornerShape(7.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 9.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = color, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, fontFamily = AppFonts.Mono)
    }
}
