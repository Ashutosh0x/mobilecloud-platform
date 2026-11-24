//! PTY master/slave session manager (terminal architecture doc §2.1).
//!
//! `portable-pty` allocates a real `/dev/pts` pair so interactive programs
//! (vim, htop, fzf, less) get line discipline, signal translation
//! (Ctrl+C → SIGINT), and alternate-screen handling — impossible over plain
//! pipes. When `tmux` is available every session attaches to a persistent
//! daemon (`tmux new-session -A -s mobilecloud-session`) per §2.3, so a closed
//! browser tab or sleeping phone screen never terminates long-running work.
//! On vanilla devices without `tmux` the session falls back to a direct
//! interactive shell instead of failing with exit code 127.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tokio::sync::mpsc;

pub const DEFAULT_ROWS: u16 = 24;
pub const DEFAULT_COLS: u16 = 80;

/// Sync control half of a live session (safe to share across tasks).
///
/// `portable_pty::MasterPty` is `Send` but not `Sync`, so the master sits
/// behind a `Mutex` — `resize` is a single short-lived `ioctl`, so lock
/// contention is negligible.
pub struct PtyControl {
    master: std::sync::Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
}

/// Split result: the control half is clone-shared; the receiver is owned by
/// exactly one output-forwarding task (`mpsc::Receiver` is `!Sync`).
pub struct PtyHandle {
    pub control: Arc<PtyControl>,
    pub output_rx: mpsc::Receiver<Vec<u8>>,
    /// Keeps the child shell process handle alive for the session's lifetime.
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl PtyControl {
    /// Write client keystrokes into the PTY slave.
    pub fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        writer.write_all(bytes)
    }

    /// `ioctl(TIOCSWINSZ)` — dispatches SIGWINCH to the running shell (§2.2).
    pub fn resize(&self, rows: u16, cols: u16) -> anyhow::Result<()> {
        self.master
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| anyhow::anyhow!("pty resize: {e}"))
    }
}

impl PtySession {
    /// Allocate a PTY pair and spawn the persistent shell inside tmux.
    pub fn spawn(
        engine_bin: &std::path::Path,
        home: &std::path::Path,
    ) -> anyhow::Result<PtyHandle> {
        Self::spawn_with_size(engine_bin, home, DEFAULT_ROWS, DEFAULT_COLS)
    }

    pub fn spawn_with_size(
        engine_bin: &std::path::Path,
        home: &std::path::Path,
        rows: u16,
        cols: u16,
    ) -> anyhow::Result<PtyHandle> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| anyhow::anyhow!("openpty: {e}"))?;

        // Sandboxed userland environment (terminal doc §3 isolation model):
        // private HOME, engine bin first on PATH, read-only system dirs.
        let shell = shell_path(engine_bin);
        let tmux = find_executable("tmux", engine_bin);
        let mut cmd = match &tmux {
            Some(tmux_bin) => CommandBuilder::new(tmux_bin.to_string_lossy().to_string()),
            None => CommandBuilder::new(shell.clone()),
        };
        cmd.env("TERM", "xterm-256color");
        cmd.env("HOME", home.join("home").to_string_lossy().to_string());
        cmd.env(
            "PATH",
            format!(
                "{}:/system/bin:/vendor/bin",
                engine_bin.to_string_lossy()
            ),
        );
        cmd.env("PS1", "mobilecloud$ ");
        cmd.env("SHELL", shell);
        cmd.cwd(home.join("home").to_string_lossy().to_string());
        if tmux.is_some() {
            // Attach to (or create) the persistent tmux session.
            cmd.args(["new-session", "-A", "-s", "mobilecloud-session"]);
        } else {
            // Vanilla device without tmux: hand out a direct interactive shell
            // rather than exiting 127 on `tmux: not found`.
            tracing::info!("tmux not found on PATH — spawning a direct interactive shell");
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| anyhow::anyhow!("spawn shell: {e}"))?;
        drop(pair.slave); // parent holds only the master end

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| anyhow::anyhow!("clone reader: {e}"))?;
        let writer = Arc::new(Mutex::new(
            pair.master
                .take_writer()
                .map_err(|e| anyhow::anyhow!("take writer: {e}"))?,
        ));

        // Bridge the blocking PTY reader into the async world.
        let (tx, output_rx) = mpsc::channel::<Vec<u8>>(64);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 2048];
            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                if tx.blocking_send(buffer[..n].to_vec()).is_err() {
                    break;
                }
            }
        });

        Ok(PtyHandle {
            control: Arc::new(PtyControl {
                master: std::sync::Mutex::new(pair.master),
                writer,
            }),
            output_rx,
            _child: child,
        })
    }
}

/// Namespace struct housing the spawn constructors.
pub struct PtySession;

/// Prefer the bundled login shell; fall back across the Android toolchain.
fn shell_path(engine_bin: &std::path::Path) -> String {
    for candidate in ["zsh", "bash", "sh"] {
        let bundled = engine_bin.join(candidate);
        if bundled.exists() {
            return bundled.to_string_lossy().into_owned();
        }
    }
    "/system/bin/sh".to_string()
}

/// Locate an executable on the child's effective PATH (engine bin first, then
/// the Android userland, then the parent process PATH). `None` means the tool
/// is genuinely absent, not merely unbundled.
fn find_executable(name: &str, engine_bin: &std::path::Path) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![engine_bin.to_path_buf()];
    for dir in ["/system/bin", "/vendor/bin", "/usr/bin", "/usr/local/bin", "/bin"] {
        dirs.push(PathBuf::from(dir));
    }
    if let Ok(path) = std::env::var("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.into_iter()
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_resolution_falls_back_to_system_sh() {
        let empty = std::path::PathBuf::from("/nonexistent-engine");
        assert_eq!(shell_path(&empty), "/system/bin/sh");
    }
}
