//! # MobileCloud Tunnel
//!
//! Secure tunnel infrastructure for MobileCloud edge services.
//!
//! This crate provides two components:
//!
//! - **Client** (`mc-tunnel-client`): Runs on the phone/device, initiates an outbound
//!   WebSocket connection to the relay, and multiplexes local services over yamux streams.
//!
//! - **Relay** (`mc-tunnel-relay`): Runs on a VPS, accepts client WebSocket connections,
//!   and proxies public HTTP requests to the appropriate yamux stream.
//!
//! ## Architecture
//!
//! ```text
//!   Phone/Device                    VPS Relay                    Public Internet
//!  ┌──────────────┐    WSS     ┌──────────────────┐    HTTP    ┌──────────────┐
//!  │ Local Service ├──yamux──► │  TunnelRelay      │◄─────────│  Browser      │
//!  │  :3210, :3211 │           │  :8443 (tunnel)   │           │  curl, etc.  │
//!  └──────────────┘           │  :8080 (public)   │           └──────────────┘
//!                              └──────────────────┘
//! ```

pub mod protocol;
pub mod mux;
pub mod client;
pub mod relay;
