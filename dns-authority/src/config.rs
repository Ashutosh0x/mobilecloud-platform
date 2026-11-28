//! Runtime configuration.
//!
//! Everything is overridable through the environment so the same binary runs
//! as a local dev node (high ports, no token) and as a production authority
//! (port 53, token required) with no recompilation.

use std::net::SocketAddr;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Port the management REST API binds to by default. 53 is the DNS port and
/// needs privileges; the control plane deliberately does not.
pub const DEFAULT_API_PORT: u16 = 8053;
/// The authoritative DNS port.
pub const DEFAULT_DNS_PORT: u16 = 53;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    /// Address the UDP listener binds to.
    pub dns_udp: SocketAddr,
    /// Address the TCP listener binds to.
    pub dns_tcp: SocketAddr,
    /// Address the management REST API binds to.
    pub api: SocketAddr,
    /// When set, zone and record state is mirrored to this JSON file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_path: Option<PathBuf>,
    /// Region used when a client matches no GeoIP prefix.
    pub default_region: String,
    /// When set, every mutating and reading request to the API must carry
    /// `Authorization: Bearer <token>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_token: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            dns_udp: SocketAddr::from(([0, 0, 0, 0], DEFAULT_DNS_PORT)),
            dns_tcp: SocketAddr::from(([0, 0, 0, 0], DEFAULT_DNS_PORT)),
            api: SocketAddr::from(([127, 0, 0, 1], DEFAULT_API_PORT)),
            store_path: None,
            default_region: "us-east".to_string(),
            api_token: None,
        }
    }
}

impl Config {
    /// Read the `MC_DNS_*` environment variables over the defaults.
    pub fn from_env() -> Result<Self, String> {
        let mut config = Config::default();
        if let Some(raw) = env("MC_DNS_UDP") {
            config.dns_udp = parse_addr("MC_DNS_UDP", &raw)?;
        }
        if let Some(raw) = env("MC_DNS_TCP") {
            config.dns_tcp = parse_addr("MC_DNS_TCP", &raw)?;
        }
        if let Some(raw) = env("MC_DNS_API") {
            config.api = parse_addr("MC_DNS_API", &raw)?;
        }
        if let Some(raw) = env("MC_DNS_STORE") {
            config.store_path = Some(PathBuf::from(raw));
        }
        if let Some(raw) = env("MC_DNS_DEFAULT_REGION") {
            if raw.trim().is_empty() {
                return Err("MC_DNS_DEFAULT_REGION must not be empty".to_string());
            }
            config.default_region = raw.trim().to_string();
        }
        if let Some(raw) = env("MC_DNS_API_TOKEN") {
            let trimmed = raw.trim().to_string();
            config.api_token = if trimmed.is_empty() { None } else { Some(trimmed) };
        }
        Ok(config)
    }
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// Parse a socket address, accepting a bare port (`"8053"`) as well as a full
/// `host:port` string.
pub fn parse_addr(key: &str, raw: &str) -> Result<SocketAddr, String> {
    let trimmed = raw.trim();
    if let Ok(port) = trimmed.parse::<u16>() {
        return Ok(SocketAddr::from(([0, 0, 0, 0], port)));
    }
    trimmed.parse::<SocketAddr>().map_err(|_| format!("{key}='{raw}' is not a valid socket address"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_loopback_api_and_public_dns() {
        let config = Config::default();
        assert_eq!(config.dns_udp.port(), 53);
        assert_eq!(config.dns_tcp.port(), 53);
        assert_eq!(config.api.port(), DEFAULT_API_PORT);
        assert!(config.api.ip().is_loopback(), "the control plane must not default to a public interface");
        assert_eq!(config.default_region, "us-east");
    }

    #[test]
    fn parses_addresses_with_and_without_a_host() {
        assert_eq!(parse_addr("MC_DNS_API", "9000").unwrap().port(), 9000);
        let full = parse_addr("MC_DNS_API", "127.0.0.1:8053").unwrap();
        assert_eq!(full.port(), 8053);
        assert!(full.ip().is_loopback());
        assert!(parse_addr("MC_DNS_API", "not-an-address").is_err());
    }
}
