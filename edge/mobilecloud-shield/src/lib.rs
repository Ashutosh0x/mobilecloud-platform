//! # mobilecloud-shield
//!
//! Rate limiting, Web Application Firewall (WAF), and IP blocklist middleware
//! for MobileCloud edge services.
//!
//! ## Components
//!
//! | Module | Purpose |
//! |--------|---------|
//! | [`rate_limiter`] | Sliding-window per-IP rate limiter backed by [`dashmap`]. |
//! | [`waf`] | Pattern-matching WAF engine with default rules for SQLi, XSS, traversal, and command injection. |
//! | [`blocklist`] | Thread-safe IP blocklist with CrowdSec-compatible JSON loading. |
//! | [`middleware`] | Tower [`Layer`](tower::Layer) / [`Service`](tower::Service) that chains all three checks. |
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use mobilecloud_shield::{
//!     blocklist::Blocklist,
//!     middleware::ShieldLayer,
//!     rate_limiter::SlidingWindowLimiter,
//!     waf::WafEngine,
//! };
//!
//! let blocklist  = Blocklist::new();
//! let limiter    = SlidingWindowLimiter::new();
//! let waf        = WafEngine::with_defaults();
//! let layer      = ShieldLayer::new(blocklist, limiter, waf);
//!
//! // Apply `layer` to your tower / axum / hyper service stack.
//! ```

pub mod blocklist;
pub mod middleware;
pub mod rate_limiter;
pub mod waf;
