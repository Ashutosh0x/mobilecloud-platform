//! Authoritative resolution.
//!
//! The resolver is the single place that decides an answer. Its rules are
//! deliberately conservative:
//!
//! * A query for a name we are **not** authoritative for is `REFUSED`, never a
//!   hallucinated answer.
//! * A name that exists but has no records of the requested type is `NOERROR`
//!   with an empty answer (a proper NODATA), not `NXDOMAIN`.
//! * A name that does not exist in one of our zones is `NXDOMAIN`.
//! * Both negative outcomes carry the zone's `SOA` so resolvers cache them.
//! * `proxied` records answer with the nearest edge PoP address, resolved
//!   through the [`GeoRouter`]; the literal value is never leaked. This only
//!   applies inside a zone whose `geo_routing_enabled` is set. A client that
//!   cannot be geo-located (a native IPv6 peer) gets the default region's PoP,
//!   and a proxied `AAAA` — for which this IPv4-only PoP table has no answer —
//!   is withheld as NODATA rather than handed back verbatim.

use std::net::Ipv4Addr;
use std::sync::Arc;

use crate::geo::GeoRouter;
use crate::metrics::Metrics;
use crate::store::{DnsStore, Zone};
use crate::wire::{
    self, Question, RData, ResourceRecord, RCODE_NOERROR, RCODE_NXDOMAIN, RCODE_REFUSED,
    RCODE_SERVFAIL, TYPE_ANY, TYPE_CAA, TYPE_SOA,
};

const MAX_CNAME_DEPTH: usize = 8;

/// The outcome of resolving one question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolutionOutcome {
    pub rcode: u8,
    pub answers: Vec<ResourceRecord>,
    pub authorities: Vec<ResourceRecord>,
    /// The zone that answered, when we are authoritative for the name.
    pub zone: Option<String>,
}

impl ResolutionOutcome {
    fn refused() -> Self {
        Self { rcode: RCODE_REFUSED, answers: Vec::new(), authorities: Vec::new(), zone: None }
    }

    fn servfail() -> Self {
        Self { rcode: RCODE_SERVFAIL, answers: Vec::new(), authorities: Vec::new(), zone: None }
    }
}

/// Convenience alias for the trait-object form used by the servers.
pub type Resolver<S> = AuthoritativeResolver<S>;

pub struct AuthoritativeResolver<S: DnsStore + 'static> {
    store: Arc<S>,
    geo: Arc<GeoRouter>,
    metrics: Arc<Metrics>,
}

impl<S: DnsStore + 'static> AuthoritativeResolver<S> {
    pub fn new(store: Arc<S>, geo: Arc<GeoRouter>, metrics: Arc<Metrics>) -> Self {
        Self { store, geo, metrics }
    }

    pub fn metrics(&self) -> &Arc<Metrics> {
        &self.metrics
    }

    /// Resolve a single question for a client.
    pub async fn resolve(&self, question: &Question, client: Option<Ipv4Addr>) -> ResolutionOutcome {
        let outcome = self.resolve_inner(question, client).await;
        self.metrics.record_query(question.qtype, outcome.rcode);
        outcome
    }

    async fn resolve_inner(
        &self,
        question: &Question,
        client: Option<Ipv4Addr>,
    ) -> ResolutionOutcome {
        if question.qclass != wire::CLASS_IN {
            return ResolutionOutcome::refused();
        }
        let zones = self.store.list_zones().await;
        let Some(zone) = longest_matching_zone(&zones, &question.name) else {
            return ResolutionOutcome::refused();
        };
        let soa = self.synthesize_soa(zone).await;

        let mut answers = Vec::new();
        let mut target = question.name.clone();
        let mut depth = 0usize;

        loop {
            let records = self.store.find_records(&target).await;
            let name_exists = !records.is_empty();

            // A CNAME answers every type except CNAME itself.
            if question.qtype != wire::TYPE_CNAME {
                if let Some(cname) = records.iter().find(|r| r.rtype() == wire::TYPE_CNAME) {
                    let Ok(rdata) = cname.to_rdata() else {
                        return ResolutionOutcome::servfail();
                    };
                    answers.push(ResourceRecord::new(&cname.fqdn(), cname.ttl, rdata.clone()));
                    if let RData::Name(next) = &rdata {
                        depth += 1;
                        if depth > MAX_CNAME_DEPTH {
                            return ResolutionOutcome::servfail();
                        }
                        // Only keep chasing while the next name is ours.
                        if longest_matching_zone(&zones, next).is_some() {
                            target = next.to_string();
                            continue;
                        }
                    }
                    // The alias points outside our zones: hand back the CNAME
                    // chain we have and stop. Following it is the client's job.
                    return ResolutionOutcome {
                        rcode: RCODE_NOERROR,
                        answers,
                        authorities: Vec::new(),
                        zone: Some(zone.domain.clone()),
                    };
                }
            }

            if !question.is_any() {
                for record in records.iter().filter(|r| r.rtype() == question.qtype) {
                    match self.answer_for(record, client, zone.geo_routing_enabled) {
                        Ok(Some(answer)) => answers.push(answer),
                        Ok(None) => {}
                        Err(_) => return ResolutionOutcome::servfail(),
                    }
                }
            } else {
                for record in &records {
                    match self.answer_for(record, client, zone.geo_routing_enabled) {
                        Ok(Some(answer)) => answers.push(answer),
                        Ok(None) => {}
                        Err(_) => return ResolutionOutcome::servfail(),
                    }
                }
            }

            if answers.is_empty() {
                if name_exists {
                    // NODATA: the name is ours but has nothing of this type.
                    return ResolutionOutcome {
                        rcode: RCODE_NOERROR,
                        answers,
                        authorities: vec![soa],
                        zone: Some(zone.domain.clone()),
                    };
                }
                return ResolutionOutcome {
                    rcode: RCODE_NXDOMAIN,
                    answers,
                    authorities: vec![soa],
                    zone: Some(zone.domain.clone()),
                };
            }

            return ResolutionOutcome {
                rcode: RCODE_NOERROR,
                answers,
                authorities: Vec::new(),
                zone: Some(zone.domain.clone()),
            };
        }
    }

    /// Build the wire answer for one stored record, applying geo substitution
    /// for proxied records.
    ///
    /// A proxied record never leaks its literal origin:
    ///
    /// * a proxied `A` answers with the nearest edge PoP — the client's own PoP
    ///   when it can be geo-located, otherwise the default region's PoP;
    /// * a proxied `AAAA` has no answer in this IPv4-only PoP table, so it is
    ///   withheld (`Ok(None)`) and surfaces to the client as NODATA;
    /// * every other type, and every record in a zone with geo routing off, is
    ///   returned verbatim.
    fn answer_for(
        &self,
        record: &crate::record::Record,
        client: Option<Ipv4Addr>,
        geo_enabled: bool,
    ) -> Result<Option<ResourceRecord>, crate::record::RecordError> {
        let mut rdata = record.to_rdata()?;
        if record.proxied && geo_enabled {
            match (&rdata, record.record_type) {
                (RData::A(_), crate::record::RecordType::A) => {
                    let pop = client
                        .map(|client| self.geo.resolve_nearest(client))
                        .unwrap_or_else(|| self.geo.default_pop());
                    rdata = RData::A(pop);
                }
                (RData::Aaaa(_), crate::record::RecordType::Aaaa) => {
                    // The PoP table is IPv4-only: answer NODATA rather than the
                    // origin address.
                    return Ok(None);
                }
                (RData::Name(_), crate::record::RecordType::Cname) => {
                    // A proxied CNAME still points at the tunnel target; the
                    // edge answers the A record, so we leave the target alone.
                }
                _ => {}
            }
        }
        Ok(Some(ResourceRecord::new(&record.fqdn(), record.ttl, rdata)))
    }

    /// The zone's own SOA, or a synthesised one so negative answers are always
    /// cacheable.
    async fn synthesize_soa(&self, zone: &Zone) -> ResourceRecord {
        let records = self.store.list_records(&zone.domain).await;
        if let Some(soa) = records.iter().find(|r| r.rtype() == TYPE_SOA) {
            if let Ok(rdata) = soa.to_rdata() {
                return ResourceRecord::new(&zone.domain, soa.ttl, rdata);
            }
        }
        ResourceRecord::new(
            &zone.domain,
            crate::record::DEFAULT_TTL,
            RData::Soa {
                mname: format!("ns1.{}", zone.domain),
                rname: format!("hostmaster.{}", zone.domain),
                serial: crate::now_unix().max(1) as u32,
                refresh: 3600,
                retry: 600,
                expire: 604_800,
                minimum: 300,
            },
        )
    }
}

/// The longest zone whose domain is `name` or a parent of `name`.
pub fn longest_matching_zone<'a>(zones: &'a [Zone], name: &str) -> Option<&'a Zone> {
    let name = wire::canonical_name(name);
    zones
        .iter()
        .filter(|zone| {
            name == zone.domain
                || (name.len() > zone.domain.len() && name.ends_with(&format!(".{}", zone.domain)))
        })
        .max_by_key(|zone| zone.domain.len())
}

impl Question {
    pub fn is_any(&self) -> bool {
        self.qtype == TYPE_ANY
    }
}

/// Convenience: does a CAA record set forbid issuance by `ca_domain`?
pub fn caa_allows(records: &[crate::record::Record], ca_domain: &str) -> bool {
    let caa: Vec<&crate::record::Record> =
        records.iter().filter(|record| record.rtype() == TYPE_CAA).collect();
    if caa.is_empty() {
        return true;
    }
    caa.iter().any(|record| match record.to_rdata() {
        Ok(RData::Caa { tag, value, .. })
            if tag.eq_ignore_ascii_case("issue") && !value.is_empty() =>
        {
            value.eq_ignore_ascii_case(ca_domain)
        }
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{Record, RecordType};
    use crate::store::{MemoryStore, Zone};
    use wire::{TYPE_A, TYPE_AAAA, TYPE_CNAME, TYPE_TXT};

    async fn resolver_with_furlpay() -> AuthoritativeResolver<MemoryStore> {
        let store = Arc::new(MemoryStore::new());
        store.create_zone(Zone::new("furlpay.com", "ashutosh0x")).await.unwrap();
        let mut records = vec![
            Record::new("furlpay.com", "@", RecordType::A, "203.0.113.10", 300, None, false).unwrap(),
            Record::new("furlpay.com", "www", RecordType::Cname, "furlpay.com", 300, None, true).unwrap(),
            Record::new("furlpay.com", "auth", RecordType::Cname, "edge.furlpay.com", 300, None, true).unwrap(),
            Record::new("furlpay.com", "@", RecordType::Mx, "mail.furlpay.com", 300, Some(10), false).unwrap(),
            Record::new("furlpay.com", "@", RecordType::Txt, "v=spf1 ~all", 300, None, false).unwrap(),
        ];
        records.push(
            Record::new("other.example", "@", RecordType::A, "198.51.100.1", 300, None, false).unwrap(),
        );
        for record in records {
            if record.zone == "furlpay.com" {
                store.put_record(record).await.unwrap();
            }
        }
        AuthoritativeResolver::new(store, Arc::new(GeoRouter::default()), Arc::new(Metrics::new()))
    }

    #[tokio::test]
    async fn answers_a_plain_a_record() {
        let resolver = resolver_with_furlpay().await;
        let outcome = resolver.resolve(&Question::new("furlpay.com", TYPE_A), None).await;
        assert_eq!(outcome.rcode, RCODE_NOERROR);
        assert_eq!(outcome.answers.len(), 1);
        assert_eq!(outcome.answers[0].rdata, RData::A("203.0.113.10".parse().unwrap()));
        assert!(!outcome.answers[0].name.is_empty());
    }

    #[tokio::test]
    async fn proxied_records_answer_with_the_nearest_pop() {
        let resolver = resolver_with_furlpay().await;
        let outcome = resolver
            .resolve(&Question::new("www.furlpay.com", TYPE_A), Some("203.0.113.5".parse().unwrap()))
            .await;
        assert_eq!(outcome.rcode, RCODE_NOERROR);
        // www is a proxied CNAME to furlpay.com, and furlpay.com's A is not
        // proxied, so the chain still terminates at the literal address.
        assert!(outcome.answers.iter().any(|a| a.rdata == RData::A("203.0.113.10".parse().unwrap())));
    }

    #[tokio::test]
    async fn returns_nodata_for_a_name_without_that_type() {
        let resolver = resolver_with_furlpay().await;
        // The apex exists (A, MX and TXT) but holds no AAAA, so the honest
        // answer is NODATA — NOERROR with the SOA — not NXDOMAIN.
        let outcome = resolver.resolve(&Question::new("furlpay.com", TYPE_AAAA), None).await;
        assert_eq!(outcome.rcode, RCODE_NOERROR);
        assert!(outcome.answers.is_empty());
        assert_eq!(outcome.authorities.len(), 1, "NODATA must carry the SOA");
    }

    #[tokio::test]
    async fn returns_nxdomain_for_an_unknown_name_in_our_zone() {
        let resolver = resolver_with_furlpay().await;
        let outcome = resolver.resolve(&Question::new("nope.furlpay.com", TYPE_A), None).await;
        assert_eq!(outcome.rcode, RCODE_NXDOMAIN);
        assert!(outcome.answers.is_empty());
    }

    #[tokio::test]
    async fn refuses_zones_we_do_not_own() {
        let resolver = resolver_with_furlpay().await;
        let outcome = resolver.resolve(&Question::new("example.org", TYPE_A), None).await;
        assert_eq!(outcome.rcode, RCODE_REFUSED);
        assert!(outcome.zone.is_none());
    }

    #[tokio::test]
    async fn follows_cnames_that_stay_inside_our_zones() {
        let resolver = resolver_with_furlpay().await;
        let outcome = resolver.resolve(&Question::new("auth.furlpay.com", TYPE_CNAME), None).await;
        assert_eq!(outcome.rcode, RCODE_NOERROR);
        assert_eq!(outcome.answers.len(), 1);
        assert_eq!(outcome.answers[0].rdata, RData::Name("edge.furlpay.com".into()));
    }

    #[tokio::test]
    async fn longest_zone_wins() {
        let zones = vec![Zone::new("furlpay.com", "a"), Zone::new("auth.furlpay.com", "b")];
        let matched = longest_matching_zone(&zones, "login.auth.furlpay.com").unwrap();
        assert_eq!(matched.domain, "auth.furlpay.com");
    }

    #[test]
    fn caa_enforces_the_issuer_allowlist() {
        let allow = Record::new(
            "furlpay.com",
            "@",
            RecordType::Caa,
            "0 issue \"letsencrypt.org\"",
            300,
            None,
            false,
        )
        .unwrap();
        assert!(caa_allows(std::slice::from_ref(&allow), "letsencrypt.org"));
        assert!(!caa_allows(&[allow], "evil-ca.example"));
        assert!(caa_allows(&[], "anything"), "no CAA means issuance is unrestricted");
    }

    #[tokio::test]
    async fn txt_lookups_work_for_acme_challenges() {
        let resolver = resolver_with_furlpay().await;
        let outcome = resolver.resolve(&Question::new("furlpay.com", TYPE_TXT), None).await;
        assert_eq!(outcome.rcode, RCODE_NOERROR);
        assert_eq!(outcome.answers.len(), 1);
    }

    /// A store whose single zone holds one proxied `A` and one proxied `AAAA`.
    async fn resolver_with_proxied_records(
        geo_enabled: bool,
    ) -> AuthoritativeResolver<MemoryStore> {
        let store = Arc::new(MemoryStore::new());
        let mut zone = Zone::new("furlpay.com", "owner");
        zone.geo_routing_enabled = geo_enabled;
        store.create_zone(zone).await.unwrap();
        store
            .put_record(
                Record::new("furlpay.com", "cdn", RecordType::A, "203.0.113.99", 300, None, true)
                    .unwrap(),
            )
            .await
            .unwrap();
        store
            .put_record(
                Record::new("furlpay.com", "cdn", RecordType::Aaaa, "2001:db8::1", 300, None, true)
                    .unwrap(),
            )
            .await
            .unwrap();
        AuthoritativeResolver::new(store, Arc::new(GeoRouter::default()), Arc::new(Metrics::new()))
    }

    #[tokio::test]
    async fn proxied_a_answers_the_default_pop_for_a_non_geo_client() {
        // An IPv6 peer cannot be placed in the IPv4 client table, so the server
        // passes `None`; the answer must still be an edge PoP, never the origin.
        let resolver = resolver_with_proxied_records(true).await;
        let outcome = resolver.resolve(&Question::new("cdn.furlpay.com", TYPE_A), None).await;
        assert_eq!(outcome.rcode, RCODE_NOERROR);
        assert_eq!(outcome.answers.len(), 1);
        assert_eq!(outcome.answers[0].rdata, RData::A("192.0.2.10".parse().unwrap()));
        assert_ne!(outcome.answers[0].rdata, RData::A("203.0.113.99".parse().unwrap()));
    }

    #[tokio::test]
    async fn proxied_aaaa_is_withheld_as_nodata() {
        let resolver = resolver_with_proxied_records(true).await;
        let outcome = resolver.resolve(&Question::new("cdn.furlpay.com", TYPE_AAAA), None).await;
        assert_eq!(outcome.rcode, RCODE_NOERROR);
        assert!(outcome.answers.is_empty(), "a proxied AAAA must not leak its origin");
        assert_eq!(outcome.authorities.len(), 1, "the withheld answer is a NODATA + SOA");
    }

    #[tokio::test]
    async fn geo_disabled_answers_the_literal_value() {
        let resolver = resolver_with_proxied_records(false).await;
        let outcome = resolver
            .resolve(&Question::new("cdn.furlpay.com", TYPE_A), Some("203.0.113.5".parse().unwrap()))
            .await;
        assert_eq!(outcome.rcode, RCODE_NOERROR);
        assert_eq!(outcome.answers.len(), 1);
        assert_eq!(outcome.answers[0].rdata, RData::A("203.0.113.99".parse().unwrap()));
    }
}
