//! `mc-dns-authority` — the MobileCloud sovereign authoritative DNS server.
//!
//! It serves DNS on UDP/TCP and exposes the management REST API that replaces
//! Cloudflare's DNS API. Configuration is entirely environment-driven; see
//! [`mc_dns_authority::config`].

use std::sync::Arc;

use mc_dns_authority::api::{self, AppState};
use mc_dns_authority::config::Config;
use mc_dns_authority::geo::GeoRouter;
use mc_dns_authority::metrics::Metrics;
use mc_dns_authority::resolver::AuthoritativeResolver;
use mc_dns_authority::server;
use mc_dns_authority::store::MemoryStore;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("mc_dns_authority=info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let config = Config::from_env()?;

    let store = Arc::new(match &config.store_path {
        Some(path) => MemoryStore::open(path)?,
        None => MemoryStore::new(),
    });

    // Reuse the built-in region table but honour the configured default region.
    let regions = GeoRouter::default().regions().to_vec();
    let geo = Arc::new(GeoRouter::from_regions(regions, &config.default_region)?);
    let metrics = Arc::new(Metrics::new());

    let resolver =
        Arc::new(AuthoritativeResolver::new(store.clone(), geo.clone(), metrics.clone()));

    let state = Arc::new(AppState {
        store: store.clone(),
        geo,
        metrics,
        api_token: config.api_token.clone(),
    });

    let api = api::router(state).layer(tower_http::trace::TraceLayer::new_for_http());
    let api_listener = tokio::net::TcpListener::bind(config.api).await?;
    tracing::info!(addr = %config.api, "management API listening");

    let (udp_addr, tcp_addr) = (config.dns_udp, config.dns_tcp);
    tracing::info!(udp = %udp_addr, tcp = %tcp_addr, "authoritative DNS listening");

    let api_task = tokio::spawn(async move { axum::serve(api_listener, api).await });
    let dns_task = tokio::spawn(server::run(resolver, udp_addr, tcp_addr));

    tokio::select! {
        result = api_task => result??,
        result = dns_task => result??,
    }

    Ok(())
}
