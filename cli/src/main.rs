//! `mobilecloud` — the MobileCloud platform CLI.
//!
//! The binary is deliberately small: it authenticates a machine with a device
//! code or a PKCE browser flow, stores the resulting tokens with restrictive
//! permissions, and manages the devices and sessions that can reach the
//! account. It never asks for a password and never prints a full token.

mod api;
mod commands;
mod config;
mod format;
mod login;
mod pkce;

use std::io::{self, Write};

use anyhow::{bail, Result};
use clap::{Parser, Subcommand, ValueEnum};

use crate::api::Api;

#[derive(Parser)]
#[command(
    name = "mobilecloud",
    version,
    about = "MobileCloud platform CLI",
    long_about = "Authenticate this machine with your MobileCloud account, then inspect and revoke the devices and sessions that can reach it.",
    disable_help_subcommand = true
)]
struct Cli {
    /// Console origin. Defaults to the server saved by `mobilecloud login`.
    #[arg(long, global = true, value_name = "URL", env = "MOBILECLOUD_SERVER")]
    server: Option<String>,

    /// Saved credential profile to use.
    #[arg(long, global = true, value_name = "NAME", default_value = "default", env = "MOBILECLOUD_PROFILE")]
    profile: String,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Authenticate this machine with your MobileCloud account.
    Login {
        /// Where to approve the sign-in.
        #[arg(long, value_enum, default_value_t = LoginMethod::Device)]
        method: LoginMethod,
        /// Do not open a browser automatically.
        #[arg(long)]
        no_browser: bool,
        /// Space separated scopes to request.
        #[arg(long, value_name = "SCOPE", default_value = "cli:full")]
        scope: String,
    },
    /// Revoke this machine's token and delete its saved credentials.
    Logout,
    /// Show the signed-in account and the token in use.
    Whoami {
        /// Print the raw account and token document.
        #[arg(long)]
        json: bool,
    },
    /// List the devices linked to your account.
    Devices {
        /// Print JSON instead of a table.
        #[arg(long)]
        json: bool,
        /// Include devices that were already revoked.
        #[arg(long)]
        all: bool,
    },
    /// List active sessions across every client.
    Sessions {
        /// Print JSON instead of a table.
        #[arg(long)]
        json: bool,
    },
    /// Revoke a linked device and every session on it.
    #[command(name = "revoke-device")]
    RevokeDevice {
        /// Device id, or a unique prefix.
        #[arg(value_name = "DEVICE")]
        id: String,
        /// Do not ask for confirmation.
        #[arg(long, short = 'y')]
        yes: bool,
    },
    /// Revoke one session.
    #[command(name = "revoke-session")]
    RevokeSession {
        /// Session id, or a unique prefix.
        #[arg(value_name = "SESSION")]
        id: String,
        /// Do not ask for confirmation.
        #[arg(long, short = 'y')]
        yes: bool,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum LoginMethod {
    /// Approve a short code from another device (works over SSH).
    Device,
    /// Open a browser and return to a loopback callback.
    Browser,
}

fn main() {
    let cli = Cli::parse();
    if let Err(error) = run(cli) {
        eprintln!("\nerror: {error:#}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Command::Login { method, no_browser, scope } => {
            let saved = config::Credentials::load()?;
            let server = match cli.server.as_deref() {
                Some(server) => server.to_string(),
                None => match saved.profile(&cli.profile) {
                    Some(profile) => profile.server.clone(),
                    None => prompt_server()?,
                },
            };
            let api = Api::connect(&server)?;
            let profile = match method {
                LoginMethod::Device => login::device(&api, &scope, no_browser),
                LoginMethod::Browser => login::browser(&api, &scope, no_browser),
            }?;
            let mut credentials = config::Credentials::load()?;
            credentials.put(&cli.profile, profile);
            credentials.save()?;
            let saved = credentials.require(&cli.profile)?;
            println!();
            println!("  Signed in as {} ({})", saved.email, saved.name);
            println!("  Role: {} · Plan: {}", saved.role, saved.plan);
            println!("  Server: {}", saved.server);
            println!("  Saved to {}", config::credentials_path().display());
            Ok(())
        }
        Command::Logout => {
            let mut session = commands::Session::open(cli.server.as_deref(), &cli.profile)?;
            commands::logout(&mut session)
        }
        Command::Whoami { json } => {
            let mut session = commands::Session::open(cli.server.as_deref(), &cli.profile)?;
            commands::whoami(&mut session, json)
        }
        Command::Devices { json, all } => {
            let mut session = commands::Session::open(cli.server.as_deref(), &cli.profile)?;
            commands::devices(&mut session, json, all)
        }
        Command::Sessions { json } => {
            let mut session = commands::Session::open(cli.server.as_deref(), &cli.profile)?;
            commands::sessions(&mut session, json)
        }
        Command::RevokeDevice { id, yes } => {
            let mut session = commands::Session::open(cli.server.as_deref(), &cli.profile)?;
            commands::revoke_device(&mut session, &id, yes)
        }
        Command::RevokeSession { id, yes } => {
            let mut session = commands::Session::open(cli.server.as_deref(), &cli.profile)?;
            commands::revoke_session(&mut session, &id, yes)
        }
    }
}

fn prompt_server() -> Result<String> {
    print!("Server URL (https://console.example.com): ");
    io::stdout().flush()?;
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    let value = line.trim();
    if value.is_empty() {
        bail!("A server URL is required the first time you sign in.");
    }
    Ok(value.to_string())
}
