//! Bun commands for trusted local preview. Process cleanup and env filtering
//! are operational safeguards, not isolation from the engine user's files,
//! credentials, subprocesses or network.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};

use crate::{builder::framework_detector::FrameworkPreset, AppState};

const STEP_TIMEOUT: Duration = Duration::from_secs(300);

pub async fn install(
    state: &AppState,
    project: &str,
    cwd: &Path,
    preset: &FrameworkPreset,
) -> anyhow::Result<()> {
    if !preset.install_args.is_empty() {
        let mut args = preset.install_args.to_vec();
        args.extend(["--ignore-scripts", "--backend=copyfile"]);
        run_bun(state, project, cwd, &args).await?;
    }
    Ok(())
}

pub async fn build(
    state: &AppState,
    project: &str,
    cwd: &Path,
    preset: &FrameworkPreset,
) -> anyhow::Result<()> {
    match preset.build_command {
        "" => Ok(()),
        "bun run build" => run_bun(state, project, cwd, &["run", "build"]).await,
        _ => anyhow::bail!("unsupported preview build command"),
    }
}

async fn run_bun(state: &AppState, project: &str, cwd: &Path, args: &[&str]) -> anyhow::Result<()> {
    let mut command_path = vec![state.engine_bin.clone()];
    if let Some(parent_path) = std::env::var_os("PATH") {
        command_path.extend(std::env::split_paths(&parent_path).filter(|p| p.is_absolute()));
    }
    let bundled = state
        .engine_bin
        .join(if cfg!(windows) { "bun.exe" } else { "bun" });
    let bun = if bundled.is_file() {
        bundled
    } else {
        PathBuf::from("bun")
    };
    // The scratch home/cache is discarded with this checkout; never hand a
    // build the supervisor environment or a shared writable dependency cache.
    let scratch = tempfile::tempdir_in(state.home.join("sources"))?;
    let mut command = tokio::process::Command::new(bun);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", std::env::join_paths(command_path)?)
        .env("HOME", scratch.path())
        .env("USERPROFILE", scratch.path())
        .env("BUN_INSTALL_CACHE_DIR", scratch.path().join("bun-cache"))
        .env("TMPDIR", scratch.path())
        .env("TEMP", scratch.path())
        .env("TMP", scratch.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if args.first() == Some(&"run") {
        command.env("NODE_ENV", "production");
    }
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    state.log_line(project, format!("[Build] bun {}", args.join(" ")));
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let result = tokio::time::timeout(STEP_TIMEOUT, async {
        tokio::try_join!(
            child.wait(),
            pump(stdout, state, project),
            pump(stderr, state, project)
        )
    })
    .await;
    match result {
        Ok(Ok((status, (), ()))) if status.success() => Ok(()),
        Ok(Ok((status, (), ()))) => anyhow::bail!("Bun exited with {status}"),
        Ok(Err(e)) => {
            let _ = child.kill().await;
            Err(e.into())
        }
        Err(_) => {
            let _ = child.kill().await;
            anyhow::bail!("Bun preview step timed out")
        }
    }
}

async fn pump(
    mut reader: impl AsyncRead + Unpin,
    state: &AppState,
    project: &str,
) -> std::io::Result<()> {
    let mut bytes = [0; 4096];
    loop {
        let n = reader.read(&mut bytes).await?;
        if n == 0 {
            return Ok(());
        }
        state.log_line(project, String::from_utf8_lossy(&bytes[..n]));
    }
}
