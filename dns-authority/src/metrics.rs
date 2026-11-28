//! Query counters exposed in the Prometheus text exposition format.
//!
//! There is deliberately no metrics crate here: the authority must start with
//! an empty dependency graph, so counters are plain atomics and rendering is a
//! few lines of `write!`. A scrape endpoint is cheap; a supply-chain surprise
//! in the DNS hot path is not.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::wire;

/// Transport a question arrived on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Udp,
    Tcp,
}

#[derive(Debug, Default)]
pub struct Metrics {
    queries_total: AtomicU64,
    answered_total: AtomicU64,
    refused_total: AtomicU64,
    nxdomain_total: AtomicU64,
    servfail_total: AtomicU64,
    malformed_total: AtomicU64,
    truncated_total: AtomicU64,
    udp_total: AtomicU64,
    tcp_total: AtomicU64,
    /// (qtype, rcode) → count. A BTreeMap keeps the exposition output stable
    /// so a scrape diff is meaningful.
    by_type: Mutex<BTreeMap<(u16, u8), u64>>,
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one answered question.
    pub fn record_query(&self, qtype: u16, rcode: u8) {
        self.queries_total.fetch_add(1, Ordering::Relaxed);
        match rcode {
            wire::RCODE_NOERROR => {
                self.answered_total.fetch_add(1, Ordering::Relaxed);
            }
            wire::RCODE_NXDOMAIN => {
                self.nxdomain_total.fetch_add(1, Ordering::Relaxed);
            }
            wire::RCODE_SERVFAIL => {
                self.servfail_total.fetch_add(1, Ordering::Relaxed);
            }
            wire::RCODE_REFUSED => {
                self.refused_total.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
        if let Ok(mut map) = self.by_type.lock() {
            *map.entry((qtype, rcode)).or_insert(0) += 1;
        }
    }

    pub fn record_transport(&self, transport: Transport) {
        match transport {
            Transport::Udp => {
                self.udp_total.fetch_add(1, Ordering::Relaxed);
            }
            Transport::Tcp => {
                self.tcp_total.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// A datagram that could not be parsed as a DNS message at all.
    pub fn record_malformed(&self) {
        self.malformed_total.fetch_add(1, Ordering::Relaxed);
    }

    /// A response that had to be truncated to fit the transport limit.
    pub fn record_truncated(&self) {
        self.truncated_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn query_count(&self) -> u64 {
        self.queries_total.load(Ordering::Relaxed)
    }

    pub fn answered_count(&self) -> u64 {
        self.answered_total.load(Ordering::Relaxed)
    }

    pub fn refused_count(&self) -> u64 {
        self.refused_total.load(Ordering::Relaxed)
    }

    pub fn nxdomain_count(&self) -> u64 {
        self.nxdomain_total.load(Ordering::Relaxed)
    }

    pub fn servfail_count(&self) -> u64 {
        self.servfail_total.load(Ordering::Relaxed)
    }

    pub fn udp_count(&self) -> u64 {
        self.udp_total.load(Ordering::Relaxed)
    }

    pub fn tcp_count(&self) -> u64 {
        self.tcp_total.load(Ordering::Relaxed)
    }

    pub fn render(&self) -> String {
        let mut out = String::with_capacity(512);
        let counters: [(&str, &str, u64); 9] = [
            ("mc_dns_queries_total", "Questions handed to the resolver.", self.query_count()),
            ("mc_dns_answered_total", "Questions answered with NOERROR.", self.answered_count()),
            ("mc_dns_refused_total", "Questions REFUSED because we are not authoritative.", self.refused_count()),
            ("mc_dns_nxdomain_total", "Questions answered NXDOMAIN.", self.nxdomain_count()),
            ("mc_dns_servfail_total", "Questions answered SERVFAIL.", self.servfail_count()),
            ("mc_dns_malformed_total", "Datagrams that were not parseable DNS messages.", self.malformed_total.load(Ordering::Relaxed)),
            ("mc_dns_truncated_total", "Responses truncated to fit the transport limit.", self.truncated_total.load(Ordering::Relaxed)),
            ("mc_dns_udp_total", "Questions received over UDP.", self.udp_count()),
            ("mc_dns_tcp_total", "Questions received over TCP.", self.tcp_count()),
        ];
        for (name, help, value) in counters {
            let _ = writeln!(out, "# HELP {name} {help}");
            let _ = writeln!(out, "# TYPE {name} counter");
            let _ = writeln!(out, "{name} {value}");
        }

        let _ = writeln!(
            out,
            "# HELP mc_dns_queries_by_type_total Questions per (type, rcode)."
        );
        let _ = writeln!(out, "# TYPE mc_dns_queries_by_type_total counter");
        if let Ok(map) = self.by_type.lock() {
            for ((qtype, rcode), count) in map.iter() {
                let _ = writeln!(
                    out,
                    "mc_dns_queries_by_type_total{{type=\"{}\",rcode=\"{}\"}} {count}",
                    type_name(*qtype),
                    rcode_name(*rcode)
                );
            }
        }
        out
    }
}

/// Human-readable RR type label, used as the metric's `type` label.
pub fn type_name(qtype: u16) -> &'static str {
    match qtype {
        wire::TYPE_A => "A",
        wire::TYPE_NS => "NS",
        wire::TYPE_CNAME => "CNAME",
        wire::TYPE_SOA => "SOA",
        wire::TYPE_PTR => "PTR",
        wire::TYPE_MX => "MX",
        wire::TYPE_TXT => "TXT",
        wire::TYPE_AAAA => "AAAA",
        wire::TYPE_SRV => "SRV",
        wire::TYPE_OPT => "OPT",
        wire::TYPE_ANY => "ANY",
        wire::TYPE_CAA => "CAA",
        _ => "OTHER",
    }
}

/// Human-readable response-code label.
pub fn rcode_name(rcode: u8) -> &'static str {
    match rcode {
        wire::RCODE_NOERROR => "NOERROR",
        wire::RCODE_FORMERR => "FORMERR",
        wire::RCODE_SERVFAIL => "SERVFAIL",
        wire::RCODE_NXDOMAIN => "NXDOMAIN",
        wire::RCODE_NOTIMP => "NOTIMP",
        wire::RCODE_REFUSED => "REFUSED",
        _ => "OTHER",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_queries_by_outcome() {
        let metrics = Metrics::new();
        metrics.record_query(wire::TYPE_A, wire::RCODE_NOERROR);
        metrics.record_query(wire::TYPE_A, wire::RCODE_NOERROR);
        metrics.record_query(wire::TYPE_TXT, wire::RCODE_NXDOMAIN);
        metrics.record_query(wire::TYPE_A, wire::RCODE_REFUSED);
        assert_eq!(metrics.query_count(), 4);
        assert_eq!(metrics.answered_count(), 2);
        assert_eq!(metrics.nxdomain_count(), 1);
        assert_eq!(metrics.refused_count(), 1);
    }

    #[test]
    fn renders_prometheus_text() {
        let metrics = Metrics::new();
        metrics.record_query(wire::TYPE_A, wire::RCODE_NOERROR);
        metrics.record_transport(Transport::Udp);
        metrics.record_malformed();
        let rendered = metrics.render();
        assert!(rendered.contains("# TYPE mc_dns_queries_total counter"));
        assert!(rendered.contains("mc_dns_queries_total 1"));
        assert!(rendered.contains("mc_dns_udp_total 1"));
        assert!(rendered.contains("mc_dns_malformed_total 1"));
        assert!(rendered.contains("mc_dns_queries_by_type_total{type=\"A\",rcode=\"NOERROR\"} 1"));
    }

    #[test]
    fn labels_cover_the_modelled_types() {
        assert_eq!(type_name(wire::TYPE_CAA), "CAA");
        assert_eq!(type_name(999), "OTHER");
        assert_eq!(rcode_name(wire::RCODE_SERVFAIL), "SERVFAIL");
        assert_eq!(rcode_name(42), "OTHER");
    }
}
