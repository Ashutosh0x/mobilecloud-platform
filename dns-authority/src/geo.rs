//! Geographic DNS routing — the "GeoDNS" layer.
//!
//! When a record is marked `proxied`, the authority answers with the edge PoP
//! nearest the client instead of the record's literal value. The prefix table
//! shipped here is a coarse, documentation-safe default: production replaces it
//! with real GeoIP data via [`GeoRouter::from_regions`]. It is deliberately
//! explicit rather than magic so an operator can audit exactly who lands where.

use std::fmt;
use std::net::Ipv4Addr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ipv4Cidr {
    pub network: u32,
    pub prefix: u8,
}

impl Ipv4Cidr {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let (addr, prefix) = raw
            .split_once('/')
            .ok_or_else(|| format!("cidr '{raw}' is missing a prefix length"))?;
        let ip: Ipv4Addr = addr
            .trim()
            .parse()
            .map_err(|_| format!("cidr '{raw}' has an invalid address"))?;
        let prefix: u8 = prefix
            .trim()
            .parse()
            .map_err(|_| format!("cidr '{raw}' has an invalid prefix length"))?;
        if prefix > 32 {
            return Err(format!("cidr '{raw}' has a prefix length greater than 32"));
        }
        Ok(Self { network: mask(ip, prefix), prefix })
    }

    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        mask(ip, self.prefix) == self.network
    }
}

impl fmt::Display for Ipv4Cidr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", Ipv4Addr::from(self.network), self.prefix)
    }
}

fn mask(ip: Ipv4Addr, prefix: u8) -> u32 {
    let bits = u32::from(ip);
    if prefix == 0 {
        0
    } else {
        bits & (u32::MAX << (32 - prefix))
    }
}

#[derive(Debug, Clone)]
pub struct GeoRegion {
    pub name: String,
    pub cidrs: Vec<Ipv4Cidr>,
    pub pops: Vec<Ipv4Addr>,
}

impl GeoRegion {
    pub fn new(name: &str, cidrs: &[&str], pops: &[&str]) -> Result<Self, String> {
        let cidrs = cidrs
            .iter()
            .map(|raw| Ipv4Cidr::parse(raw))
            .collect::<Result<Vec<_>, _>>()?;
        let pops = pops
            .iter()
            .map(|raw| raw.parse::<Ipv4Addr>().map_err(|_| format!("bad PoP address '{raw}'")))
            .collect::<Result<Vec<_>, _>>()?;
        if pops.is_empty() {
            return Err(format!("region '{name}' has no PoPs"));
        }
        Ok(Self { name: name.to_string(), cidrs, pops })
    }
}

#[derive(Debug, Clone)]
pub struct GeoRouter {
    regions: Vec<GeoRegion>,
    default_index: usize,
}

impl Default for GeoRouter {
    fn default() -> Self {
        // Documentation-range prefixes (RFC 5737) and private space. These are
        // placeholders for a real GeoIP table, not production routing data.
        let regions = vec![
            GeoRegion::new(
                "us-east",
                &["192.0.2.0/24", "10.0.0.0/8", "127.0.0.0/8"],
                &["192.0.2.10"],
            )
            .expect("static region"),
            GeoRegion::new("eu-central", &["198.51.100.0/24"], &["198.51.100.10"])
                .expect("static region"),
            GeoRegion::new("ap-south", &["203.0.113.0/24"], &["203.0.113.10"])
                .expect("static region"),
        ];
        Self { regions, default_index: 0 }
    }
}

impl GeoRouter {
    pub fn from_regions(regions: Vec<GeoRegion>, default_region: &str) -> Result<Self, String> {
        if regions.is_empty() {
            return Err("geo router needs at least one region".into());
        }
        let default_index = regions
            .iter()
            .position(|region| region.name == default_region)
            .ok_or_else(|| format!("default region '{default_region}' is not defined"))?;
        Ok(Self { regions, default_index })
    }

    pub fn regions(&self) -> &[GeoRegion] {
        &self.regions
    }

    /// The region a client belongs to, falling back to the default region.
    pub fn region_for(&self, client: Ipv4Addr) -> &str {
        self.regions
            .iter()
            .find(|region| region.cidrs.iter().any(|cidr| cidr.contains(client)))
            .unwrap_or(&self.regions[self.default_index])
            .name
            .as_str()
    }

    /// The nearest PoP address for a client, or the default region's first PoP.
    pub fn resolve_nearest(&self, client: Ipv4Addr) -> Ipv4Addr {
        let region = self
            .regions
            .iter()
            .find(|region| region.cidrs.iter().any(|cidr| cidr.contains(client)))
            .unwrap_or(&self.regions[self.default_index]);
        region.pops[0]
    }

    /// The default region's first PoP. Used when a client cannot be
    /// geo-located at all — a native IPv6 peer against this IPv4 client table —
    /// so a proxied record answers with an edge address instead of leaking the
    /// origin.
    pub fn default_pop(&self) -> Ipv4Addr {
        self.regions[self.default_index].pops[0]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn router() -> GeoRouter {
        GeoRouter::default()
    }

    #[test]
    fn cidr_matching_is_exact() {
        let cidr = Ipv4Cidr::parse("203.0.113.0/24").unwrap();
        assert!(cidr.contains("203.0.113.255".parse().unwrap()));
        assert!(!cidr.contains("203.0.114.1".parse().unwrap()));
        assert_eq!(cidr.to_string(), "203.0.113.0/24");
    }

    #[test]
    fn cidr_handles_edge_prefix_lengths() {
        let all = Ipv4Cidr::parse("0.0.0.0/0").unwrap();
        assert!(all.contains("8.8.8.8".parse().unwrap()));
        let host = Ipv4Cidr::parse("203.0.113.7/32").unwrap();
        assert!(host.contains("203.0.113.7".parse().unwrap()));
        assert!(!host.contains("203.0.113.8".parse().unwrap()));
        assert!(Ipv4Cidr::parse("203.0.113.0/33").is_err());
    }

    #[test]
    fn routes_clients_to_the_nearest_pop() {
        let geo = router();
        assert_eq!(geo.resolve_nearest("203.0.113.5".parse().unwrap()), "203.0.113.10".parse::<Ipv4Addr>().unwrap());
        assert_eq!(geo.region_for("203.0.113.5".parse().unwrap()), "ap-south");
        assert_eq!(geo.region_for("198.51.100.7".parse().unwrap()), "eu-central");
        assert_eq!(geo.region_for("10.1.2.3".parse().unwrap()), "us-east");
    }

    #[test]
    fn unknown_clients_fall_back_to_the_default_region() {
        let geo = router();
        assert_eq!(geo.region_for("8.8.8.8".parse().unwrap()), "us-east");
    }

    #[test]
    fn default_pop_is_the_default_region_entry_point() {
        let geo = router();
        assert_eq!(geo.default_pop(), "192.0.2.10".parse::<Ipv4Addr>().unwrap());
    }

    #[test]
    fn rejects_a_default_region_that_does_not_exist() {
        let regions = vec![GeoRegion::new("us-east", &["192.0.2.0/24"], &["192.0.2.10"]).unwrap()];
        assert!(GeoRouter::from_regions(regions, "mars").is_err());
    }
}
