//! Bun 1.2+ hardlink dependency compiler (research report §8.2, benchmark §3).
//!
//! Execution model on-device:
//! * Dependencies are **not** downloaded per-project. Bun maintains a global
//!   content-addressed store under `<home>/cache/bun`; packages are
//!   hardlinked into each project's `node_modules` in **< 1.5s**.
//! * Turbopack compiles Next.js 15 on the 4.32 GHz Oryon prime cores in
//!   **~14.2s**; incremental UI-only commits land in **4–8s**.
//! * The thermal governor clamps build concurrency when the SoC exceeds the
//!   configured ceiling (default 45°C) — research report §5.3.

use std::path::Path;

use tokio::io::AsyncBufReadExt;

use crate::builder::framework_detector::FrameworkPreset;
use crate::AppState;

/// SoC ceiling (°C) before the scheduler lowers build concurrency.
pub const THERMAL_CEILING_CELSIUS: f32 = 45.0;

/// Current maximum SoC temperature from `/sys/class/thermal/thermal_zone*/temp`.
pub fn read_soc_temp_celsius() -> f32 {
    let mut best: Option<u32> = None;
    if let Ok(entries) = std::fs::read_dir("/sys/class/thermal") {
        for entry in entries.flatten() {
            let p = entry.path().join("temp");
            if let Ok(raw) = std::fs::read_to_string(&p) {
                if let Ok(milli) = raw.trim().parse::<u32>() {
                    best = Some(match best {
                        Some(b) => b.max(milli),
                        None => milli,
                    });
                }
            }
        }
    }
    best.map(|m| m as f32 / 1000.0).unwrap_or(31.0) // emulated fallback (Snapdragon idle)
}

/// Resolve the engine binary: bundled ARM64 build first, PATH second.
fn resolve_engine_bin(state: &AppState, name: &str) -> String {
    let bundled = state.engine_bin.join(name);
    if bundled.exists() {
        bundled.to_string_lossy().into_owned()
    } else {
        name.to_string()
    }
}

/// `bun install --frozen-lockfile` with the global hardlink cache.
pub async fn install(
    state: &std::sync::Arc<AppState>,
    project: &str,
    source_dir: &Path,
    preset: &FrameworkPreset,
) -> anyhow::Result<()> {
    if preset.install_args.is_empty() {
        return Ok(());
    }
    run_streaming(state, project, "bun", preset.install_args, source_dir).await
}

/// Framework compilation (Turbopack / Nitro / Vite as detected).
pub async fn build(
    state: &std::sync::Arc<AppState>,
    project: &str,
    source_dir: &Path,
    preset: &FrameworkPreset,
) -> anyhow::Result<()> {
    if preset.build_command.is_empty() {
        state.log_line(project, "[Build] Static preset: no compile step.").await;
        return Ok(());
    }

    // Thermal-aware backoff: sustained compiles spike all 8 cores to 10–14W;
    // above the ceiling we yield until thermals normalize (research §5.3).
    let temp = read_soc_temp_celsius();
    if temp > THERMAL_CEILING_CELSIUS {
        state
            .log_line(
                project,
                format!(
                    "[Thermal] SoC at {temp:.1}°C > {THERMAL_CEILING_CELSIUS}°C — backoff before compile"
                ),
            )
            .await;
        while read_soc_temp_celsius() > THERMAL_CEILING_CELSIUS {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        }
    }

    let mut parts = preset.build_command.split_whitespace();
    let program = parts.next().unwrap_or("bun").to_string();
    let args: Vec<&str> = parts.collect();
    run_streaming(state, project, &program, &args, source_dir).await
}

/// Spawn a build-process child and stream stdout/stderr line-by-line into the
/// project's SSE log hub (real-time build log stream, master §3 Screen 2).
pub async fn run_streaming(
    state: &std::sync::Arc<AppState>,
    project: &str,
    program: &str,
    args: &[&str],
    cwd: &Path,
) -> anyhow::Result<()> {
    let bin = resolve_engine_bin(state, program);
    state.log_line(project, format!("[Build] $ {program} {}", args.join(" "))).await;

    let mut child = tokio::process::Command::new(&bin)
        .args(args)
        .current_dir(cwd)
        .env("NODE_ENV", "production")
        .env("PATH", format!("{}:/usr/bin:/bin", state.engine_bin.display()))
        .env("HOME", state.home.join("home").to_string_lossy().to_string())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| anyhow::anyhow!("failed to spawn {bin}: {e}"))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let state_out = state.clone();
    let project_out = project.to_string();
    let out_task = tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            state_out.log_line(&project_out, format!("[Build] {line}")).await;
        }
    });
    let state_err = state.clone();
    let project_err = project.to_string();
    let err_task = tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            state_err.log_line(&project_err, format!("[Build] {line}")).await;
        }
    });

    let status = child.wait().await?;
    let _ = out_task.await;
    let _ = err_task.await;

    if !status.success() {
        anyhow::bail!("{program} exited with {}", status.code().unwrap_or(-1));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thermal_reader_falls_back_on_desktop() {
        // Non-Android hosts get the emulated idle figure rather than a panic.
        let t = read_soc_temp_celsius();
        assert!(t > 0.0 && t < 120.0);
    }
}
