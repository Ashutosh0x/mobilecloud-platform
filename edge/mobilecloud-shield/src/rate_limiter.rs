//! Sliding-window rate limiter with per-IP tracking.
//!
//! Uses [`DashMap`] for lock-free concurrent access and a background tokio task
//! to periodically prune expired window entries.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use thiserror::Error;
use tracing::{debug, info};

/// Error returned when a client exceeds the rate limit.
#[derive(Debug, Clone, Error)]
#[error("rate limit exceeded — retry after {retry_after_secs}s")]
pub struct RateLimitExceeded {
    /// Seconds the client should wait before retrying.
    pub retry_after_secs: u64,
}

/// Per-IP sliding-window state.
#[derive(Debug, Clone)]
struct WindowState {
    /// Number of requests recorded in the current window.
    count: u64,
    /// Timestamp when the current window started.
    window_start: Instant,
}

/// Configuration for [`SlidingWindowLimiter`].
#[derive(Debug, Clone)]
pub struct RateLimiterConfig {
    /// Maximum number of requests allowed per window.  Default: **100**.
    pub max_requests_per_window: u64,
    /// Duration of a single sliding window.  Default: **60 s**.
    pub window_duration: Duration,
    /// How often the background task prunes expired entries.  Default: **120 s**.
    pub cleanup_interval: Duration,
}

impl Default for RateLimiterConfig {
    fn default() -> Self {
        Self {
            max_requests_per_window: 100,
            window_duration: Duration::from_secs(60),
            cleanup_interval: Duration::from_secs(120),
        }
    }
}

/// A sliding-window rate limiter keyed on client IP addresses.
///
/// Each IP gets a window that starts on its first request. When the window
/// elapses the counter is reset.  Stale entries are cleaned up by a background
/// tokio task spawned via [`SlidingWindowLimiter::start_cleanup_task`].
#[derive(Debug, Clone)]
pub struct SlidingWindowLimiter {
    inner: Arc<SlidingWindowLimiterInner>,
}

#[derive(Debug)]
struct SlidingWindowLimiterInner {
    windows: DashMap<IpAddr, WindowState>,
    config: RateLimiterConfig,
}

impl SlidingWindowLimiter {
    /// Create a new limiter with default configuration.
    pub fn new() -> Self {
        Self::with_config(RateLimiterConfig::default())
    }

    /// Create a new limiter with the given configuration.
    pub fn with_config(config: RateLimiterConfig) -> Self {
        Self {
            inner: Arc::new(SlidingWindowLimiterInner {
                windows: DashMap::new(),
                config,
            }),
        }
    }

    /// Spawn a background tokio task that periodically removes expired window
    /// entries.  Call this once after creating the limiter.
    pub fn start_cleanup_task(&self) {
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(inner.config.cleanup_interval);
            loop {
                interval.tick().await;
                let now = Instant::now();
                let before = inner.windows.len();
                inner.windows.retain(|_ip, state| {
                    now.duration_since(state.window_start) < inner.config.window_duration
                });
                let pruned = before - inner.windows.len();
                if pruned > 0 {
                    debug!(pruned, remaining = inner.windows.len(), "rate-limiter cleanup");
                }
            }
        });
        info!(
            max = self.inner.config.max_requests_per_window,
            window_secs = self.inner.config.window_duration.as_secs(),
            "rate-limiter cleanup task started"
        );
    }

    /// Check whether `ip` is within the rate limit.
    ///
    /// Returns `Ok(())` if the request is allowed or
    /// [`Err(RateLimitExceeded)`](RateLimitExceeded) with the number of seconds
    /// the client should wait before retrying.
    pub fn check(&self, ip: IpAddr) -> Result<(), RateLimitExceeded> {
        let now = Instant::now();
        let config = &self.inner.config;

        let mut entry = self
            .inner
            .windows
            .entry(ip)
            .or_insert_with(|| WindowState {
                count: 0,
                window_start: now,
            });

        let state = entry.value_mut();

        // If the window has elapsed, reset it.
        let elapsed = now.duration_since(state.window_start);
        if elapsed >= config.window_duration {
            state.count = 1;
            state.window_start = now;
            return Ok(());
        }

        // Window is still active — check the count.
        if state.count >= config.max_requests_per_window {
            let remaining = config.window_duration - elapsed;
            return Err(RateLimitExceeded {
                retry_after_secs: remaining.as_secs().max(1),
            });
        }

        state.count += 1;
        Ok(())
    }

    /// Return the number of IPs currently tracked.
    pub fn tracked_ips(&self) -> usize {
        self.inner.windows.len()
    }
}

impl Default for SlidingWindowLimiter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_limit() {
        let limiter = SlidingWindowLimiter::with_config(RateLimiterConfig {
            max_requests_per_window: 3,
            window_duration: Duration::from_secs(60),
            ..Default::default()
        });
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        assert!(limiter.check(ip).is_ok());
        assert!(limiter.check(ip).is_ok());
        assert!(limiter.check(ip).is_ok());
        assert!(limiter.check(ip).is_err());
    }
}
