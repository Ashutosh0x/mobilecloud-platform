//! Framework auto-detection (research report §8.1 matrix).
//!
//! Inspects the fetched repository root to determine the build strategy:
//!
//! | Detected files            | Preset      | Build command             | Output target      |
//! |---------------------------|-------------|---------------------------|--------------------|
//! | next.config.{js,mjs,ts}   | Next.js     | bun run build             | .next/standalone   |
//! | vite.config.{js,ts}       | Vite        | bun run build             | dist/              |
//! | astro.config.{mjs,js,ts}  | Astro       | bun run build             | dist/              |
//! | nuxt.config.{ts,js}       | Nuxt 3      | bun run build             | .output/           |
//! | package.json + express    | Node API    | bun install               | ./ (persistent)    |
//! | go.mod                    | Go          | go build -o server .      | ./server           |
//! | Cargo.toml                | Rust        | cargo build --release     | target/release/    |

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameworkPreset {
    pub name: &'static str,
    /// Install command args handed to Bun (empty = skip).
    pub install_args: &'static [&'static str],
    /// Build command args handed to Bun (empty = none).
    pub build_command: &'static str,
    /// Source-relative directory the build emits.
    pub output_dir: &'static str,
    /// How the engine executes the deployment.
    pub runtime: RuntimeKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeKind {
    /// Static file serving via the Build Output v3 router.
    Static,
    /// SSR/serverless via the warm Bun/Node worker pool.
    NodeSsr,
    /// Pre-built native ARM64 executable supervised directly.
    NativeBinary(&'static str),
}

/// Detect the framework preset of a fetched source tree.
pub fn detect(source_dir: &Path) -> anyhow::Result<FrameworkPreset> {
    let has = |name: &str| source_dir.join(name).exists();

    // --- JavaScript meta-frameworks, in specificity order. ---
    for cfg in ["next.config.js", "next.config.mjs", "next.config.ts"] {
        if has(cfg) {
            return Ok(FrameworkPreset {
                name: "Next.js (App/Pages Router, Turbopack preset)",
                install_args: &["install", "--frozen-lockfile"],
                build_command: "bun run build",
                output_dir: ".next/standalone",
                runtime: RuntimeKind::NodeSsr,
            });
        }
    }
    for cfg in ["vite.config.js", "vite.config.ts", "vite.config.mjs"] {
        if has(cfg) {
            return Ok(FrameworkPreset {
                name: "Vite (React / Vue / Svelte)",
                install_args: &["install", "--frozen-lockfile"],
                build_command: "bun run build",
                output_dir: "dist",
                runtime: RuntimeKind::Static,
            });
        }
    }
    for cfg in ["astro.config.mjs", "astro.config.js", "astro.config.ts"] {
        if has(cfg) {
            return Ok(FrameworkPreset {
                name: "Astro",
                install_args: &["install", "--frozen-lockfile"],
                build_command: "bun run build",
                output_dir: "dist",
                runtime: RuntimeKind::Static,
            });
        }
    }
    for cfg in ["nuxt.config.ts", "nuxt.config.js"] {
        if has(cfg) {
            return Ok(FrameworkPreset {
                name: "Nuxt 3 (Nitro)",
                install_args: &["install", "--frozen-lockfile"],
                build_command: "bun run build",
                output_dir: ".output",
                runtime: RuntimeKind::NodeSsr,
            });
        }
    }

    // --- package.json heuristics (persistent Node API services). ---
    if has("package.json") {
        let manifest = std::fs::read_to_string(source_dir.join("package.json"))
            .unwrap_or_default();
        let value: serde_json::Value = serde_json::from_str(&manifest).unwrap_or(serde_json::Value::Null);
        let deps = value
            .get("dependencies")
            .and_then(|d| d.as_object())
            .cloned()
            .unwrap_or_default();
        if deps.contains_key("express") || deps.contains_key("fastify") {
            return Ok(FrameworkPreset {
                name: "Node.js REST API",
                install_args: &["install", "--frozen-lockfile"],
                build_command: "bun run build",
                output_dir: ".",
                runtime: RuntimeKind::NodeSsr,
            });
        }
        // Plain scripts-only package: run whatever "build" script exists.
        return Ok(FrameworkPreset {
            name: "Generic JavaScript",
            install_args: &["install", "--frozen-lockfile"],
            build_command: "bun run build",
            output_dir: "dist",
            runtime: RuntimeKind::Static,
        });
    }

    // --- Native languages. ---
    if has("go.mod") {
        return Ok(FrameworkPreset {
            name: "Go Backend",
            install_args: &[],
            build_command: "go build -o server .",
            output_dir: ".",
            runtime: RuntimeKind::NativeBinary("server"),
        });
    }
    if has("Cargo.toml") {
        return Ok(FrameworkPreset {
            name: "Rust Axum / Actix",
            install_args: &[],
            build_command: "cargo build --release",
            output_dir: "target/release",
            runtime: RuntimeKind::NativeBinary("server"),
        });
    }

    // --- Final fallback: raw static directory. ---
    if has("index.html") {
        return Ok(FrameworkPreset {
            name: "Static HTML",
            install_args: &[],
            build_command: "",
            output_dir: ".",
            runtime: RuntimeKind::Static,
        });
    }

    anyhow::bail!("no recognizable framework in {}", source_dir.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_all_preset_markers() {
        let cases: Vec<(&str, &str)> = vec![
            ("next.config.mjs", "Next.js"),
            ("vite.config.ts", "Vite"),
            ("astro.config.mjs", "Astro"),
            ("nuxt.config.ts", "Nuxt"),
            ("go.mod", "Go"),
            ("Cargo.toml", "Rust"),
        ];
        for (marker, expected_prefix) in cases {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join(marker), "").unwrap();
            let preset = detect(dir.path()).unwrap();
            assert!(
                preset.name.starts_with(expected_prefix),
                "{marker} → {} (expected {expected_prefix}*)",
                preset.name
            );
        }
    }

    #[test]
    fn express_dependency_routes_to_persistent_node() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"dependencies":{"express":"^5.0.0"}}"#,
        )
        .unwrap();
        let preset = detect(dir.path()).unwrap();
        assert!(preset.name.contains("REST API"));
        assert!(matches!(preset.runtime, RuntimeKind::NodeSsr));
    }

    #[test]
    fn rejects_unknown_roots() {
        let dir = tempfile::tempdir().unwrap();
        assert!(detect(dir.path()).is_err());
    }
}
