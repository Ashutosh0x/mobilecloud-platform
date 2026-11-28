//! DNS wire-format codec (RFC 1035 §4, RFC 3596, RFC 2782, RFC 6844).
//!
//! MobileCloud owns this codec rather than depending on a third-party
//! resolver library: the authoritative server must be able to parse and emit
//! DNS messages with no external code in the hot path. Names are stored in
//! canonical form (lower-case, no trailing dot, root = empty string) so that
//! lookups are a plain string comparison.

use std::collections::HashMap;
use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};

use thiserror::Error;

pub const TYPE_A: u16 = 1;
pub const TYPE_NS: u16 = 2;
pub const TYPE_CNAME: u16 = 5;
pub const TYPE_SOA: u16 = 6;
pub const TYPE_PTR: u16 = 12;
pub const TYPE_MX: u16 = 15;
pub const TYPE_TXT: u16 = 16;
pub const TYPE_AAAA: u16 = 28;
pub const TYPE_SRV: u16 = 33;
/// EDNS(0) pseudo-record, only ever legal in the additional section.
pub const TYPE_OPT: u16 = 41;
/// `ANY` (RFC 8482): answer with everything we hold, or a HINFO refusal.
pub const TYPE_ANY: u16 = 255;
pub const TYPE_CAA: u16 = 257;

pub const CLASS_IN: u16 = 1;

pub const RCODE_NOERROR: u8 = 0;
pub const RCODE_FORMERR: u8 = 1;
pub const RCODE_SERVFAIL: u8 = 2;
pub const RCODE_NXDOMAIN: u8 = 3;
pub const RCODE_NOTIMP: u8 = 4;
pub const RCODE_REFUSED: u8 = 5;

pub const OPCODE_QUERY: u8 = 0;

/// Maximum length of a single DNS label.
pub const MAX_LABEL_LEN: usize = 63;
/// Maximum length of a fully-qualified DNS name in wire form.
pub const MAX_NAME_LEN: usize = 255;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WireError {
    #[error("message truncated")]
    Truncated,
    #[error("name compression loop detected")]
    NameLoop,
    #[error("label exceeds 63 octets")]
    LabelTooLong,
    #[error("name exceeds 255 octets")]
    NameTooLong,
    #[error("unsupported label type (0x{0:02x})")]
    BadLabel(u8),
    #[error("malformed rdata for type {0}")]
    BadRData(u16),
    #[error("invalid presentation format: {0}")]
    Invalid(&'static str),
}

/// Canonicalise a presentation-format name: lower-case, strip a single
/// trailing dot, and leave the root as the empty string.
pub fn canonical_name(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('.');
    trimmed.to_ascii_lowercase()
}

/// The typed content of a resource record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RData {
    A(Ipv4Addr),
    Aaaa(Ipv6Addr),
    /// CNAME, NS and PTR all carry a single domain name.
    Name(String),
    Mx { preference: u16, exchange: String },
    Txt(Vec<String>),
    Srv { priority: u16, weight: u16, port: u16, target: String },
    Caa { flags: u8, tag: String, value: String },
    Soa {
        mname: String,
        rname: String,
        serial: u32,
        refresh: u32,
        retry: u32,
        expire: u32,
        minimum: u32,
    },
    /// Any type this server does not model; carried verbatim.
    Raw(Vec<u8>),
}

impl RData {
    /// Wire length of the rdata, used for the RDLENGTH field.
    pub fn wire_len(&self) -> usize {
        match self {
            RData::A(_) => 4,
            RData::Aaaa(_) => 16,
            RData::Name(n) => name_wire_len(n),
            RData::Mx { exchange, .. } => 2 + name_wire_len(exchange),
            RData::Txt(parts) => parts.iter().map(|p| 1 + p.len()).sum(),
            RData::Srv { target, .. } => 6 + name_wire_len(target),
            RData::Caa { tag, value, .. } => 2 + tag.len() + value.len(),
            RData::Soa { mname, rname, .. } => name_wire_len(mname) + name_wire_len(rname) + 20,
            RData::Raw(bytes) => bytes.len(),
        }
    }

    fn encode(&self, out: &mut Vec<u8>) -> Result<(), WireError> {
        match self {
            RData::A(ip) => out.extend_from_slice(&ip.octets()),
            RData::Aaaa(ip) => out.extend_from_slice(&ip.octets()),
            RData::Name(name) => write_name_uncompressed(name, out)?,
            RData::Mx { preference, exchange } => {
                out.extend_from_slice(&preference.to_be_bytes());
                write_name_uncompressed(exchange, out)?;
            }
            RData::Txt(parts) => {
                for part in parts {
                    if part.len() > 255 {
                        return Err(WireError::Invalid("TXT character-string exceeds 255 octets"));
                    }
                    out.push(part.len() as u8);
                    out.extend_from_slice(part.as_bytes());
                }
            }
            RData::Srv { priority, weight, port, target } => {
                out.extend_from_slice(&priority.to_be_bytes());
                out.extend_from_slice(&weight.to_be_bytes());
                out.extend_from_slice(&port.to_be_bytes());
                write_name_uncompressed(target, out)?;
            }
            RData::Caa { flags, tag, value } => {
                out.push(*flags);
                if tag.len() > 255 {
                    return Err(WireError::Invalid("CAA tag exceeds 255 octets"));
                }
                out.push(tag.len() as u8);
                out.extend_from_slice(tag.as_bytes());
                out.extend_from_slice(value.as_bytes());
            }
            RData::Soa { mname, rname, serial, refresh, retry, expire, minimum } => {
                write_name_uncompressed(mname, out)?;
                write_name_uncompressed(rname, out)?;
                out.extend_from_slice(&serial.to_be_bytes());
                out.extend_from_slice(&refresh.to_be_bytes());
                out.extend_from_slice(&retry.to_be_bytes());
                out.extend_from_slice(&expire.to_be_bytes());
                out.extend_from_slice(&minimum.to_be_bytes());
            }
            RData::Raw(bytes) => out.extend_from_slice(bytes),
        }
        Ok(())
    }

    fn parse(rtype: u16, buf: &[u8], start: usize, rdlen: usize) -> Result<RData, WireError> {
        let end = start.checked_add(rdlen).ok_or(WireError::Truncated)?;
        if end > buf.len() {
            return Err(WireError::Truncated);
        }
        let body = &buf[start..end];
        match rtype {
            TYPE_A => {
                if body.len() != 4 {
                    return Err(WireError::BadRData(TYPE_A));
                }
                Ok(RData::A(Ipv4Addr::new(body[0], body[1], body[2], body[3])))
            }
            TYPE_AAAA => {
                if body.len() != 16 {
                    return Err(WireError::BadRData(TYPE_AAAA));
                }
                let mut octets = [0u8; 16];
                octets.copy_from_slice(body);
                Ok(RData::Aaaa(Ipv6Addr::from(octets)))
            }
            TYPE_CNAME | TYPE_NS | TYPE_PTR => {
                let (name, _) = read_name(buf, start)?;
                Ok(RData::Name(name))
            }
            TYPE_MX => {
                if body.len() < 3 {
                    return Err(WireError::BadRData(TYPE_MX));
                }
                let preference = u16::from_be_bytes([body[0], body[1]]);
                let (exchange, _) = read_name(buf, start + 2)?;
                Ok(RData::Mx { preference, exchange })
            }
            TYPE_TXT => {
                let mut parts = Vec::new();
                let mut offset = 0;
                while offset < body.len() {
                    let len = body[offset] as usize;
                    offset += 1;
                    if offset + len > body.len() {
                        return Err(WireError::BadRData(TYPE_TXT));
                    }
                    parts.push(String::from_utf8_lossy(&body[offset..offset + len]).to_string());
                    offset += len;
                }
                Ok(RData::Txt(parts))
            }
            TYPE_SRV => {
                if body.len() < 7 {
                    return Err(WireError::BadRData(TYPE_SRV));
                }
                let priority = u16::from_be_bytes([body[0], body[1]]);
                let weight = u16::from_be_bytes([body[2], body[3]]);
                let port = u16::from_be_bytes([body[4], body[5]]);
                let (target, _) = read_name(buf, start + 6)?;
                Ok(RData::Srv { priority, weight, port, target })
            }
            TYPE_CAA => {
                if body.len() < 2 {
                    return Err(WireError::BadRData(TYPE_CAA));
                }
                let flags = body[0];
                let tag_len = body[1] as usize;
                if 2 + tag_len > body.len() {
                    return Err(WireError::BadRData(TYPE_CAA));
                }
                let tag = String::from_utf8_lossy(&body[2..2 + tag_len]).to_string();
                let value = String::from_utf8_lossy(&body[2 + tag_len..]).to_string();
                Ok(RData::Caa { flags, tag, value })
            }
            TYPE_SOA => {
                let (mname, after_mname) = read_name(buf, start)?;
                let (rname, after_rname) = read_name(buf, after_mname)?;
                if after_rname + 20 > buf.len() {
                    return Err(WireError::BadRData(TYPE_SOA));
                }
                let read_u32 = |at: usize| {
                    u32::from_be_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]])
                };
                Ok(RData::Soa {
                    mname,
                    rname,
                    serial: read_u32(after_rname),
                    refresh: read_u32(after_rname + 4),
                    retry: read_u32(after_rname + 8),
                    expire: read_u32(after_rname + 12),
                    minimum: read_u32(after_rname + 16),
                })
            }
            _ => Ok(RData::Raw(body.to_vec())),
        }
    }
}

fn name_wire_len(name: &str) -> usize {
    let canonical = canonical_name(name);
    if canonical.is_empty() {
        return 1;
    }
    canonical.split('.').map(|label| 1 + label.len()).sum::<usize>() + 1
}

fn write_name_uncompressed(name: &str, out: &mut Vec<u8>) -> Result<(), WireError> {
    let canonical = canonical_name(name);
    if canonical.is_empty() {
        out.push(0);
        return Ok(());
    }
    let mut total = 0usize;
    for label in canonical.split('.') {
        if label.is_empty() {
            return Err(WireError::Invalid("empty label in name"));
        }
        if label.len() > MAX_LABEL_LEN {
            return Err(WireError::LabelTooLong);
        }
        total += label.len() + 1;
        if total + 1 > MAX_NAME_LEN {
            return Err(WireError::NameTooLong);
        }
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    Ok(())
}

/// Reads a (possibly compressed) name starting at `start`.
///
/// Returns the canonical name and the offset immediately after the name in the
/// *original* stream — i.e. after the first compression pointer if one was used.
fn read_name(buf: &[u8], start: usize) -> Result<(String, usize), WireError> {
    let mut labels: Vec<String> = Vec::new();
    let mut pos = start;
    let mut end = None;
    let mut jumps = 0usize;
    loop {
        let len = *buf.get(pos).ok_or(WireError::Truncated)?;
        if len & 0xC0 == 0xC0 {
            let next = *buf.get(pos + 1).ok_or(WireError::Truncated)?;
            let pointer = (((len as usize) & 0x3F) << 8) | next as usize;
            if end.is_none() {
                end = Some(pos + 2);
            }
            jumps += 1;
            if jumps > 128 || pointer >= buf.len() {
                return Err(WireError::NameLoop);
            }
            pos = pointer;
            continue;
        }
        if len & 0xC0 != 0 {
            return Err(WireError::BadLabel(len));
        }
        pos += 1;
        if len == 0 {
            if end.is_none() {
                end = Some(pos);
            }
            break;
        }
        let len = len as usize;
        let label = buf.get(pos..pos + len).ok_or(WireError::Truncated)?;
        labels.push(String::from_utf8_lossy(label).to_string());
        pos += len;
    }
    Ok((labels.join(".").to_ascii_lowercase(), end.unwrap_or(pos)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub id: u16,
    pub flags: u16,
}

impl Header {
    pub fn new_query(id: u16, rd: bool) -> Self {
        let mut flags = 0u16;
        if rd {
            flags |= 0x0100;
        }
        Self { id, flags }
    }

    pub fn qr(&self) -> bool {
        self.flags & 0x8000 != 0
    }
    pub fn opcode(&self) -> u8 {
        ((self.flags >> 11) & 0x0F) as u8
    }
    pub fn authoritative(&self) -> bool {
        self.flags & 0x0400 != 0
    }
    pub fn truncated(&self) -> bool {
        self.flags & 0x0200 != 0
    }
    pub fn recursion_desired(&self) -> bool {
        self.flags & 0x0100 != 0
    }
    pub fn recursion_available(&self) -> bool {
        self.flags & 0x0080 != 0
    }
    pub fn rcode(&self) -> u8 {
        (self.flags & 0x000F) as u8
    }

    pub fn set_response(&mut self) {
        self.flags |= 0x8000;
    }
    pub fn set_authoritative(&mut self) {
        self.flags |= 0x0400;
    }
    pub fn set_rcode(&mut self, rcode: u8) {
        self.flags = (self.flags & 0xFFF0) | (rcode as u16 & 0x000F);
    }
}

impl fmt::Display for Header {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "id={} qr={} rcode={}", self.id, self.qr(), self.rcode())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub name: String,
    pub qtype: u16,
    pub qclass: u16,
}

impl Question {
    pub fn new(name: &str, qtype: u16) -> Self {
        Self { name: canonical_name(name), qtype, qclass: CLASS_IN }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceRecord {
    pub name: String,
    pub rtype: u16,
    pub class: u16,
    pub ttl: u32,
    pub rdata: RData,
}

impl ResourceRecord {
    pub fn new(name: &str, ttl: u32, rdata: RData) -> Self {
        Self {
            name: canonical_name(name),
            rtype: rdata_type(&rdata),
            class: CLASS_IN,
            ttl,
            rdata,
        }
    }
}

/// The RR type that corresponds to a given rdata variant.
pub fn rdata_type(rdata: &RData) -> u16 {
    match rdata {
        RData::A(_) => TYPE_A,
        RData::Aaaa(_) => TYPE_AAAA,
        RData::Name(_) => TYPE_CNAME,
        RData::Mx { .. } => TYPE_MX,
        RData::Txt(_) => TYPE_TXT,
        RData::Srv { .. } => TYPE_SRV,
        RData::Caa { .. } => TYPE_CAA,
        RData::Soa { .. } => TYPE_SOA,
        RData::Raw(_) => 0,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub header: Header,
    pub questions: Vec<Question>,
    pub answers: Vec<ResourceRecord>,
    pub authorities: Vec<ResourceRecord>,
    pub additionals: Vec<ResourceRecord>,
}

impl Message {
    pub fn new(id: u16) -> Self {
        Self {
            header: Header::new_query(id, false),
            questions: Vec::new(),
            answers: Vec::new(),
            authorities: Vec::new(),
            additionals: Vec::new(),
        }
    }

    /// Parse a complete DNS message.
    pub fn parse(buf: &[u8]) -> Result<Message, WireError> {
        if buf.len() < 12 {
            return Err(WireError::Truncated);
        }
        let header = Header {
            id: u16::from_be_bytes([buf[0], buf[1]]),
            flags: u16::from_be_bytes([buf[2], buf[3]]),
        };
        let qdcount = u16::from_be_bytes([buf[4], buf[5]]) as usize;
        let ancount = u16::from_be_bytes([buf[6], buf[7]]) as usize;
        let nscount = u16::from_be_bytes([buf[8], buf[9]]) as usize;
        let arcount = u16::from_be_bytes([buf[10], buf[11]]) as usize;

        let mut pos = 12usize;
        let mut questions = Vec::with_capacity(qdcount.min(64));
        for _ in 0..qdcount {
            let (name, next) = read_name(buf, pos)?;
            pos = next;
            let qtype = read_u16(buf, pos)?;
            let qclass = read_u16(buf, pos + 2)?;
            pos += 4;
            questions.push(Question { name, qtype, qclass });
        }

        let parse_rrs = |count: usize, pos: &mut usize| -> Result<Vec<ResourceRecord>, WireError> {
            let mut out = Vec::with_capacity(count.min(256));
            for _ in 0..count {
                let (name, next) = read_name(buf, *pos)?;
                *pos = next;
                let rtype = read_u16(buf, *pos)?;
                let class = read_u16(buf, *pos + 2)?;
                let ttl = read_u32(buf, *pos + 4)?;
                let rdlen = read_u16(buf, *pos + 8)? as usize;
                let rdata_start = *pos + 10;
                if rdata_start + rdlen > buf.len() {
                    return Err(WireError::Truncated);
                }
                let rdata = RData::parse(rtype, buf, rdata_start, rdlen)?;
                *pos = rdata_start + rdlen;
                out.push(ResourceRecord { name, rtype, class, ttl, rdata });
            }
            Ok(out)
        };

        let answers = parse_rrs(ancount, &mut pos)?;
        let authorities = parse_rrs(nscount, &mut pos)?;
        let additionals = parse_rrs(arcount, &mut pos)?;

        Ok(Message { header, questions, answers, authorities, additionals })
    }

    /// Serialise the message, compressing owner names.
    pub fn encode(&self) -> Result<Vec<u8>, WireError> {
        let mut out = Vec::with_capacity(512);
        out.extend_from_slice(&self.header.id.to_be_bytes());
        out.extend_from_slice(&self.header.flags.to_be_bytes());
        out.extend_from_slice(&(self.questions.len() as u16).to_be_bytes());
        out.extend_from_slice(&(self.answers.len() as u16).to_be_bytes());
        out.extend_from_slice(&(self.authorities.len() as u16).to_be_bytes());
        out.extend_from_slice(&(self.additionals.len() as u16).to_be_bytes());

        let mut names = NameCompressor::default();
        for question in &self.questions {
            names.write(&question.name, &mut out)?;
            out.extend_from_slice(&question.qtype.to_be_bytes());
            out.extend_from_slice(&question.qclass.to_be_bytes());
        }
        for section in [&self.answers, &self.authorities, &self.additionals] {
            for rr in section {
                names.write(&rr.name, &mut out)?;
                out.extend_from_slice(&rr.rtype.to_be_bytes());
                out.extend_from_slice(&rr.class.to_be_bytes());
                out.extend_from_slice(&rr.ttl.to_be_bytes());
                let mut rdata = Vec::with_capacity(rr.rdata.wire_len());
                rr.rdata.encode(&mut rdata)?;
                out.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
                out.extend_from_slice(&rdata);
            }
        }
        Ok(out)
    }
}

#[derive(Default)]
struct NameCompressor {
    seen: HashMap<String, u16>,
}

impl NameCompressor {
    fn write(&mut self, name: &str, out: &mut Vec<u8>) -> Result<(), WireError> {
        let canonical = canonical_name(name);
        if canonical.is_empty() {
            out.push(0);
            return Ok(());
        }
        let labels: Vec<&str> = canonical.split('.').collect();
        let mut total = 0usize;
        for (index, label) in labels.iter().enumerate() {
            if label.is_empty() {
                return Err(WireError::Invalid("empty label in name"));
            }
            if label.len() > MAX_LABEL_LEN {
                return Err(WireError::LabelTooLong);
            }
            total += label.len() + 1;
            if total + 1 > MAX_NAME_LEN {
                return Err(WireError::NameTooLong);
            }
            let suffix = labels[index..].join(".");
            if let Some(&offset) = self.seen.get(&suffix) {
                if offset <= 0x3FFF {
                    out.extend_from_slice(&(0xC000u16 | offset).to_be_bytes());
                    return Ok(());
                }
            }
            if out.len() <= 0x3FFF {
                self.seen.insert(suffix, out.len() as u16);
            }
            out.push(label.len() as u8);
            out.extend_from_slice(label.as_bytes());
        }
        out.push(0);
        Ok(())
    }
}

fn read_u16(buf: &[u8], pos: usize) -> Result<u16, WireError> {
    let a = *buf.get(pos).ok_or(WireError::Truncated)?;
    let b = *buf.get(pos + 1).ok_or(WireError::Truncated)?;
    Ok(u16::from_be_bytes([a, b]))
}

fn read_u32(buf: &[u8], pos: usize) -> Result<u32, WireError> {
    let a = *buf.get(pos).ok_or(WireError::Truncated)?;
    let b = *buf.get(pos + 1).ok_or(WireError::Truncated)?;
    let c = *buf.get(pos + 2).ok_or(WireError::Truncated)?;
    let d = *buf.get(pos + 3).ok_or(WireError::Truncated)?;
    Ok(u32::from_be_bytes([a, b, c, d]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rr(name: &str, rdata: RData) -> ResourceRecord {
        ResourceRecord::new(name, 300, rdata)
    }

    #[test]
    fn canonicalises_names() {
        assert_eq!(canonical_name("API.FurlPay.com."), "api.furlpay.com");
        assert_eq!(canonical_name(""), "");
        assert_eq!(canonical_name("."), "");
    }

    #[test]
    fn parses_a_query_message() {
        let query = [
            0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, b'a',
            b'p', b'i', 0x07, b'f', b'u', b'r', b'l', b'p', b'a', b'y', 0x03, b'c', b'o', b'm',
            0x00, 0x00, 0x01, 0x00, 0x01,
        ];
        let message = Message::parse(&query).expect("parse");
        assert_eq!(message.header.id, 0x1234);
        assert!(message.header.recursion_desired());
        assert_eq!(message.questions.len(), 1);
        assert_eq!(message.questions[0].name, "api.furlpay.com");
        assert_eq!(message.questions[0].qtype, TYPE_A);
        assert_eq!(message.questions[0].qclass, CLASS_IN);
    }

    #[test]
    fn round_trips_typed_rdata() {
        let mut message = Message::new(0xBEEF);
        message.header.set_response();
        message.header.set_authoritative();
        message.questions.push(Question::new("furlpay.com", TYPE_A));
        message.answers.push(rr("furlpay.com", RData::A("203.0.113.10".parse().unwrap())));
        message
            .answers
            .push(rr("furlpay.com", RData::Aaaa("2001:db8::1".parse().unwrap())));
        message.answers.push(rr("www.furlpay.com", RData::Name("furlpay.com".into())));
        message
            .answers
            .push(rr("furlpay.com", RData::Mx { preference: 10, exchange: "mail.furlpay.com".into() }));
        message.answers.push(rr("furlpay.com", RData::Txt(vec!["v=spf1 ~all".into()])));
        message.answers.push(rr(
            "_acme-challenge.furlpay.com",
            RData::Txt(vec!["token-value".into()]),
        ));
        message.answers.push(rr(
            "furlpay.com",
            RData::Caa { flags: 0, tag: "issue".into(), value: "letsencrypt.org".into() },
        ));
        message.answers.push(rr(
            "_sip._tcp.furlpay.com",
            RData::Srv { priority: 0, weight: 5, port: 5060, target: "sip.furlpay.com".into() },
        ));
        message.authorities.push(rr(
            "furlpay.com",
            RData::Soa {
                mname: "ns1.furlpay.com".into(),
                rname: "hostmaster.furlpay.com".into(),
                serial: 2026112801,
                refresh: 3600,
                retry: 600,
                expire: 604800,
                minimum: 300,
            },
        ));

        let bytes = message.encode().expect("encode");
        let parsed = Message::parse(&bytes).expect("re-parse");
        assert_eq!(parsed.answers, message.answers);
        assert_eq!(parsed.authorities, message.authorities);
        assert_eq!(parsed.questions, message.questions);
    }

    #[test]
    fn compresses_repeated_owner_names() {
        let mut message = Message::new(1);
        message.questions.push(Question::new("furlpay.com", TYPE_A));
        message.answers.push(rr("furlpay.com", RData::A("203.0.113.10".parse().unwrap())));
        message.answers.push(rr("furlpay.com", RData::A("203.0.113.11".parse().unwrap())));
        let bytes = message.encode().expect("encode");
        // Header (12) + question (17) puts the first answer owner at 29, where
        // the name is already known and is therefore written as a pointer.
        // Answer 1 = pointer(2) + type/class/ttl/rdlen(10) + rdata(4) = 16 bytes.
        let second_owner = 12 + 17 + 16;
        assert_eq!(bytes[second_owner], 0xC0);
        assert_eq!(bytes[second_owner + 1], 12);
        let parsed = Message::parse(&bytes).expect("re-parse");
        assert_eq!(parsed.answers.len(), 2);
        assert_eq!(parsed.answers[1].name, "furlpay.com");
    }

    #[test]
    fn rejects_truncated_messages() {
        assert_eq!(Message::parse(&[0u8; 4]).unwrap_err(), WireError::Truncated);
        let mut message = Message::new(1);
        message.questions.push(Question::new("furlpay.com", TYPE_A));
        let bytes = message.encode().unwrap();
        assert!(Message::parse(&bytes[..bytes.len() - 3]).is_err());
    }

    #[test]
    fn rejects_label_over_63_octets() {
        let long = "a".repeat(64);
        let mut message = Message::new(1);
        message.questions.push(Question::new(&format!("{long}.com"), TYPE_A));
        assert_eq!(message.encode().unwrap_err(), WireError::LabelTooLong);
    }
}
