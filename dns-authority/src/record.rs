//! The stored record model and conversion into wire rdata.
//!
//! Records are stored in presentation form, exactly like the Cloudflare DNS
//! API this replaces: the record `name` is *relative* to its zone (`"@"` is the
//! apex, `"auth"` is `auth.example.com`). The fully-qualified name is derived
//! on demand so a zone rename can never leave stale absolute names behind.

use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::wire::{self, RData};

/// Counter used to mint record identifiers that are unique within a process.
static RECORD_SEQ: AtomicU64 = AtomicU64::new(1);

pub const DEFAULT_TTL: u32 = 300;
pub const MIN_TTL: u32 = 0;
pub const MAX_TTL: u32 = 604_800;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RecordError {
    #[error("unknown record type '{0}'")]
    UnknownType(String),
    #[error("invalid {rtype} value '{value}': {reason}")]
    InvalidValue { rtype: &'static str, value: String, reason: &'static str },
    #[error("record name '{0}' is not a valid label")]
    InvalidName(String),
    #[error("ttl {0} is outside the allowed range 0..=604800")]
    InvalidTtl(u32),
    #[error("record name does not belong to zone '{zone}'")]
    NotInZone { zone: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum RecordType {
    A,
    Aaaa,
    Cname,
    Mx,
    Txt,
    Ns,
    Srv,
    Caa,
    Soa,
}

impl RecordType {
    pub fn parse(raw: &str) -> Result<Self, RecordError> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "A" => Ok(Self::A),
            "AAAA" => Ok(Self::Aaaa),
            "CNAME" => Ok(Self::Cname),
            "MX" => Ok(Self::Mx),
            "TXT" => Ok(Self::Txt),
            "NS" => Ok(Self::Ns),
            "SRV" => Ok(Self::Srv),
            "CAA" => Ok(Self::Caa),
            "SOA" => Ok(Self::Soa),
            other => Err(RecordError::UnknownType(other.to_string())),
        }
    }

    pub fn to_u16(self) -> u16 {
        match self {
            Self::A => wire::TYPE_A,
            Self::Ns => wire::TYPE_NS,
            Self::Cname => wire::TYPE_CNAME,
            Self::Soa => wire::TYPE_SOA,
            Self::Mx => wire::TYPE_MX,
            Self::Txt => wire::TYPE_TXT,
            Self::Aaaa => wire::TYPE_AAAA,
            Self::Srv => wire::TYPE_SRV,
            Self::Caa => wire::TYPE_CAA,
        }
    }

    pub fn from_u16(raw: u16) -> Option<Self> {
        match raw {
            wire::TYPE_A => Some(Self::A),
            wire::TYPE_NS => Some(Self::Ns),
            wire::TYPE_CNAME => Some(Self::Cname),
            wire::TYPE_SOA => Some(Self::Soa),
            wire::TYPE_MX => Some(Self::Mx),
            wire::TYPE_TXT => Some(Self::Txt),
            wire::TYPE_AAAA => Some(Self::Aaaa),
            wire::TYPE_SRV => Some(Self::Srv),
            wire::TYPE_CAA => Some(Self::Caa),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::A => "A",
            Self::Aaaa => "AAAA",
            Self::Cname => "CNAME",
            Self::Mx => "MX",
            Self::Txt => "TXT",
            Self::Ns => "NS",
            Self::Srv => "SRV",
            Self::Caa => "CAA",
            Self::Soa => "SOA",
        }
    }
}

impl fmt::Display for RecordType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A record as stored and served by the authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub id: u64,
    /// Zone this record belongs to, e.g. `furlpay.com`.
    pub zone: String,
    /// Label relative to the zone; `"@"` or `""` means the apex.
    pub name: String,
    pub record_type: RecordType,
    pub value: String,
    pub ttl: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u16>,
    /// When true the record is answered with the nearest edge PoP address
    /// instead of its literal value (the Cloudflare "orange cloud").
    #[serde(default)]
    pub proxied: bool,
}

impl Record {
    pub fn new(
        zone: &str,
        name: &str,
        record_type: RecordType,
        value: &str,
        ttl: u32,
        priority: Option<u16>,
        proxied: bool,
    ) -> Result<Self, RecordError> {
        let zone = wire::canonical_name(zone);
        let name = normalize_label(name)?;
        if !(MIN_TTL..=MAX_TTL).contains(&ttl) {
            return Err(RecordError::InvalidTtl(ttl));
        }
        let record = Self {
            id: RECORD_SEQ.fetch_add(1, Ordering::Relaxed),
            zone,
            name,
            record_type,
            value: value.trim().to_string(),
            ttl,
            priority,
            proxied,
        };
        record.to_rdata()?;
        Ok(record)
    }

    /// The fully-qualified owner name in canonical form.
    pub fn fqdn(&self) -> String {
        if self.name.is_empty() {
            self.zone.clone()
        } else {
            format!("{}.{}", self.name, self.zone)
        }
    }

    pub fn rtype(&self) -> u16 {
        self.record_type.to_u16()
    }

    /// Convert the presentation-form value into wire rdata.
    pub fn to_rdata(&self) -> Result<RData, RecordError> {
        let value = self.value.trim();
        let invalid = |reason: &'static str| RecordError::InvalidValue {
            rtype: self.record_type.as_str(),
            value: value.to_string(),
            reason,
        };
        match self.record_type {
            RecordType::A => value
                .parse::<Ipv4Addr>()
                .map(RData::A)
                .map_err(|_| invalid("expected a dotted-quad IPv4 address")),
            RecordType::Aaaa => value
                .parse::<Ipv6Addr>()
                .map(RData::Aaaa)
                .map_err(|_| invalid("expected an IPv6 address")),
            RecordType::Cname | RecordType::Ns => {
                validate_hostname(value).map_err(|_| invalid("expected a hostname"))?;
                Ok(RData::Name(wire::canonical_name(value)))
            }
            RecordType::Mx => {
                validate_hostname(value).map_err(|_| invalid("expected a mail-exchange hostname"))?;
                Ok(RData::Mx {
                    preference: self.priority.unwrap_or(10),
                    exchange: wire::canonical_name(value),
                })
            }
            RecordType::Txt => {
                if value.len() > 255 {
                    return Err(invalid("TXT character-string exceeds 255 octets"));
                }
                Ok(RData::Txt(vec![value.to_string()]))
            }
            RecordType::Srv => {
                let parts: Vec<&str> = value.split_whitespace().collect();
                if parts.len() != 3 {
                    return Err(invalid("expected 'weight port target'"));
                }
                let weight = parts[0].parse::<u16>().map_err(|_| invalid("weight is not a u16"))?;
                let port = parts[1].parse::<u16>().map_err(|_| invalid("port is not a u16"))?;
                validate_hostname(parts[2]).map_err(|_| invalid("target is not a hostname"))?;
                Ok(RData::Srv {
                    priority: self.priority.unwrap_or(0),
                    weight,
                    port,
                    target: wire::canonical_name(parts[2]),
                })
            }
            RecordType::Caa => parse_caa(value).map_err(&invalid),
            RecordType::Soa => parse_soa(value).map_err(&invalid),
        }
    }
}

/// Normalise a relative record name: `"@"`/`""` becomes the apex, everything
/// else is lower-cased and validated label by label.
pub fn normalize_label(raw: &str) -> Result<String, RecordError> {
    let trimmed = raw.trim().trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "@" {
        return Ok(String::new());
    }
    if trimmed.starts_with('_') {
        // Service labels such as `_acme-challenge` are legal DNS labels.
    }
    for label in trimmed.split('.') {
        if label.is_empty()
            || label.len() > wire::MAX_LABEL_LEN
            || !label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || label.starts_with('-')
        {
            return Err(RecordError::InvalidName(raw.to_string()));
        }
    }
    Ok(trimmed.to_ascii_lowercase())
}

/// Validate a hostname that appears in a record *value* position.
pub fn validate_hostname(raw: &str) -> Result<(), RecordError> {
    let canonical = wire::canonical_name(raw);
    if canonical.is_empty() {
        return Err(RecordError::InvalidName(raw.to_string()));
    }
    if canonical.len() > wire::MAX_NAME_LEN {
        return Err(RecordError::InvalidName(raw.to_string()));
    }
    for label in canonical.split('.') {
        if label.is_empty()
            || label.len() > wire::MAX_LABEL_LEN
            || !label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || label.starts_with('-')
            || label.ends_with('-')
        {
            return Err(RecordError::InvalidName(raw.to_string()));
        }
    }
    Ok(())
}

fn parse_caa(value: &str) -> Result<RData, &'static str> {
    let mut parts = value.splitn(3, char::is_whitespace);
    let flags = parts
        .next()
        .and_then(|f| f.parse::<u8>().ok())
        .ok_or("expected 'flags tag value'")?;
    let tag = parts.next().ok_or("expected a CAA tag")?.to_string();
    let raw_value = parts.next().ok_or("expected a CAA value")?.trim();
    let unquoted = raw_value.trim_matches('"').to_string();
    if tag.is_empty() {
        return Err("expected a CAA tag");
    }
    Ok(RData::Caa { flags, tag, value: unquoted })
}

fn parse_soa(value: &str) -> Result<RData, &'static str> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() != 7 {
        return Err("expected 'mname rname serial refresh retry expire minimum'");
    }
    let number = |raw: &str| raw.parse::<u32>().map_err(|_| "SOA field is not a u32");
    Ok(RData::Soa {
        mname: wire::canonical_name(parts[0]),
        rname: wire::canonical_name(parts[1]),
        serial: number(parts[2])?,
        refresh: number(parts[3])?,
        retry: number(parts[4])?,
        expire: number(parts[5])?,
        minimum: number(parts[6])?,
    })
}

/// Presentation form of rdata, used when echoing records back over the API.
pub fn rdata_to_value(rdata: &RData) -> String {
    match rdata {
        RData::A(ip) => ip.to_string(),
        RData::Aaaa(ip) => ip.to_string(),
        RData::Name(name) => name.clone(),
        RData::Mx { exchange, .. } => exchange.clone(),
        RData::Txt(parts) => parts.join(" "),
        RData::Srv { weight, port, target, .. } => format!("{weight} {port} {target}"),
        RData::Caa { flags, tag, value } => format!("{flags} {tag} \"{value}\""),
        RData::Soa { mname, rname, serial, refresh, retry, expire, minimum } => {
            format!("{mname} {rname} {serial} {refresh} {retry} {expire} {minimum}")
        }
        RData::Raw(bytes) => hex::encode(bytes),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_fully_qualified_names() {
        let apex = Record::new("FurlPay.com", "@", RecordType::A, "203.0.113.10", 300, None, false)
            .unwrap();
        assert_eq!(apex.fqdn(), "furlpay.com");
        let sub = Record::new("furlpay.com", "API", RecordType::Cname, "edge.furlpay.com", 300, None, true)
            .unwrap();
        assert_eq!(sub.fqdn(), "api.furlpay.com");
    }

    #[test]
    fn rejects_bad_values_per_type() {
        assert!(Record::new("furlpay.com", "@", RecordType::A, "not-an-ip", 300, None, false).is_err());
        assert!(Record::new("furlpay.com", "@", RecordType::Aaaa, "203.0.113.1", 300, None, false).is_err());
        assert!(Record::new("furlpay.com", "@", RecordType::Cname, "bad_host!", 300, None, false).is_err());
        assert!(Record::new("furlpay.com", "@", RecordType::Srv, "not three parts", 300, None, false).is_err());
        assert!(Record::new("furlpay.com", "@", RecordType::A, "203.0.113.1", 999_999, None, false).is_err());
    }

    #[test]
    fn builds_caa_and_soa_rdata() {
        let caa = Record::new(
            "furlpay.com",
            "@",
            RecordType::Caa,
            "0 issue \"letsencrypt.org\"",
            300,
            None,
            false,
        )
        .unwrap();
        assert_eq!(
            caa.to_rdata().unwrap(),
            RData::Caa { flags: 0, tag: "issue".into(), value: "letsencrypt.org".into() }
        );

        let soa = Record::new(
            "furlpay.com",
            "@",
            RecordType::Soa,
            "ns1.furlpay.com hostmaster.furlpay.com 2026112801 3600 600 604800 300",
            300,
            None,
            false,
        )
        .unwrap();
        match soa.to_rdata().unwrap() {
            RData::Soa { serial, minimum, .. } => {
                assert_eq!(serial, 2026112801);
                assert_eq!(minimum, 300);
            }
            other => panic!("expected SOA, got {other:?}"),
        }
    }

    #[test]
    fn mx_uses_priority_field() {
        let mx = Record::new("furlpay.com", "@", RecordType::Mx, "mail.furlpay.com", 300, Some(10), false)
            .unwrap();
        assert_eq!(
            mx.to_rdata().unwrap(),
            RData::Mx { preference: 10, exchange: "mail.furlpay.com".into() }
        );
    }

    #[test]
    fn normalises_relative_labels() {
        assert_eq!(normalize_label("@").unwrap(), "");
        assert_eq!(normalize_label("_acme-challenge").unwrap(), "_acme-challenge");
        assert_eq!(normalize_label("A.B").unwrap(), "a.b");
        assert!(normalize_label("-bad").is_err());
        assert!(normalize_label("bad label").is_err());
    }
}
