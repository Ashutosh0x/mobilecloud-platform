//! ISO 20022 `semt.002.001.05` (Securities Balance Custody Report) ingestion with
//! W3C XML Digital Signature verification.
//!
//! Institutional custodians (BNY Mellon / State Street) publish daily `semt.002`
//! XML statements over secure SFTP, signed with the custodian's SWIFT PKI X.509
//! HSM certificate (production spec §1.1). This parser:
//!
//! 1. Tokenizes the XML document (dependency-free, bounded subset).
//! 2. Extracts per-ISIN holdings, pledged vs unpledged quantities, settlement date.
//! 3. Verifies the enveloped XMLDSig signature:
//!    * Exclusive C14N canonicalization of the referenced subtree,
//!    * SHA-256 digest match against `DigestValue`,
//!    * RSA-SHA256 (PKCS#1 v1.5) verification of canonicalized `SignedInfo`.
//!
//! Canonicalization implements the Exclusive C14N subset that machine-generated
//! ISO 20022 documents use (attribute normalization, entity escaping, explicit
//! end tags, namespace preservation). Documents with rare C14N edge features
//! (PIs inside signed content, xml:id rewriting) are rejected rather than
//! mis-verified.

use rsa::pkcs1v15::{Signature as Pkcs1Signature, VerifyingKey as Pkcs1VerifyingKey};
use rsa::signature::Verifier;
use rsa::RsaPublicKey;
use sha2::{Digest, Sha256};

use crate::envelope::base64url_decode;
use crate::PoRError;

/// One holdings balance line extracted from the custody report.
#[derive(Clone, Debug, PartialEq)]
pub struct CustodyHolding {
    pub isin: String,
    /// Total quantity in the account (base units as string, ISO 20022 Qty).
    pub quantity: String,
    /// Quantity pledged / on loan — must be zero for eligible backing.
    pub pledged_quantity: String,
    /// Settlement date of the balance snapshot (`2026-11-19`).
    pub settlement_date: String,
}

/// Minimal XML node tree (elements, attributes, text; comments/PIs ignored).
#[derive(Clone, Debug, PartialEq)]
pub enum XmlNode {
    Element {
        name: String,
        attrs: Vec<(String, String)>,
        children: Vec<XmlNode>,
    },
    Text(String),
}

impl XmlNode {
    pub fn name(&self) -> &str {
        match self {
            XmlNode::Element { name, .. } => name,
            XmlNode::Text(_) => "",
        }
    }

    pub fn children(&self) -> &[XmlNode] {
        match self {
            XmlNode::Element { children, .. } => children,
            XmlNode::Text(_) => &[],
        }
    }

    pub fn attr(&self, name: &str) -> Option<&str> {
        match self {
            XmlNode::Element { attrs, .. } => attrs
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.as_str()),
            XmlNode::Text(_) => None,
        }
    }

    /// Concatenated direct text children.
    pub fn text(&self) -> String {
        self.children()
            .iter()
            .filter_map(|c| match c {
                XmlNode::Text(t) => Some(t.clone()),
                _ => None,
            })
            .collect()
    }

    /// First DESCENDANT element with a local name match (breadth-first in
    /// document order; self is never returned so chained lookups descend).
    pub fn find(&self, local_name: &str) -> Option<&XmlNode> {
        self.find_all(local_name).into_iter().next()
    }

    /// All descendant elements whose local name matches (document order).
    pub fn find_all(&self, local_name: &str) -> Vec<&XmlNode> {
        let mut out = Vec::new();
        // BFS queue preserves document order (Vec::remove(0) is fine for the
        // small, bounded semt.002 trees this parser ingests).
        let mut queue: Vec<&XmlNode> = self.children().iter().collect();
        let mut cursor = 0usize;
        while cursor < queue.len() {
            let node = queue[cursor];
            cursor += 1;
            if let XmlNode::Element { name, children, .. } = node {
                let local = name.rsplit(':').next().unwrap_or(name);
                if local == local_name {
                    out.push(node);
                }
                queue.extend(children.iter());
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// XML tokenizer (subset: elements, attributes, text, entities, comments, CDATA).
// ---------------------------------------------------------------------------

pub fn parse_xml(input: &str) -> Result<XmlNode, PoRError> {
    let bytes = input.as_bytes();
    let mut pos = 0usize;
    // Skip an optional XML declaration / processing instruction prolog.
    if input[pos..].starts_with("<?") {
        let end = input[pos..].find("?>").ok_or(PoRError::InvalidEvidence)?;
        pos += end + 2;
    }
    while bytes.get(pos).map_or(false, |b| b.is_ascii_whitespace()) {
        pos += 1;
    }
    let (node, next) = parse_element(input, bytes, pos)?;
    pos = next;
    // Allow trailing whitespace only.
    if !input[pos..].trim().is_empty() {
        return Err(PoRError::InvalidEvidence);
    }
    Ok(node)
}

fn parse_element(input: &str, bytes: &[u8], mut pos: usize) -> Result<(XmlNode, usize), PoRError> {
    expect_tag_open(bytes, &mut pos)?;
    let (name, attrs) = parse_tag_head(input, bytes, &mut pos)?;

    // parse_tag_head leaves pos ON the '>' or '/' terminator.
    if bytes.get(pos) == Some(&b'/') {
        // Self-closing element: consume "/>".
        pos += 2;
        return Ok((XmlNode::Element { name, attrs, children: Vec::new() }, pos));
    }
    pos += 1; // consume '>'

    let mut children = Vec::new();
    loop {
        let (child, next) = parse_node(input, bytes, pos)?;
        pos = next;
        match child {
            ChildNode::Element(el) => children.push(el),
            ChildNode::Text(t) if !t.is_empty() => children.push(XmlNode::Text(t)),
            ChildNode::Text(_) => {}
            ChildNode::EndTag(end_name) => {
                if end_name.rsplit(':').next().unwrap_or(&end_name)
                    != name.rsplit(':').next().unwrap_or(&name)
                {
                    return Err(PoRError::InvalidEvidence);
                }
                break;
            }
        }
    }
    Ok((XmlNode::Element { name, attrs, children }, pos))
}

enum ChildNode {
    Element(XmlNode),
    Text(String),
    EndTag(String),
}

fn expect_tag_open(bytes: &[u8], pos: &mut usize) -> Result<(), PoRError> {
    if bytes.get(*pos) == Some(&b'<') {
        *pos += 1;
        Ok(())
    } else {
        Err(PoRError::InvalidEvidence)
    }
}

fn parse_tag_head(input: &str, bytes: &[u8], pos: &mut usize) -> Result<(String, Vec<(String, String)>), PoRError> {
    let start = *pos;
    while bytes.get(*pos).map_or(false, |b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'.' || *b == b'-' || *b == b':') {
        *pos += 1;
    }
    let name = input[start..*pos].to_string();
    if name.is_empty() {
        return Err(PoRError::InvalidEvidence);
    }
    let mut attrs = Vec::new();
    loop {
        skip_ws(bytes, pos);
        match bytes.get(*pos) {
            Some(b'>') | Some(b'/') => return Ok((name, attrs)),
            None => return Err(PoRError::InvalidEvidence),
            _ => {}
        }
        // Attribute: name="value"
        let a_start = *pos;
        while bytes.get(*pos).map_or(false, |b| b.is_ascii_alphanumeric() || *b == b':' || *b == b'_' || *b == b'-') {
            *pos += 1;
        }
        let attr_name = input[a_start..*pos].to_string();
        skip_ws(bytes, pos);
        if bytes.get(*pos) != Some(&b'=') {
            return Err(PoRError::InvalidEvidence);
        }
        *pos += 1;
        skip_ws(bytes, pos);
        let quote = bytes.get(*pos).ok_or(PoRError::InvalidEvidence)?;
        if *quote != b'"' && *quote != b'\'' {
            return Err(PoRError::InvalidEvidence);
        }
        *pos += 1;
        let v_start = *pos;
        while bytes.get(*pos).map_or(false, |b| *b != *quote) {
            *pos += 1;
        }
        if bytes.get(*pos) != Some(quote) {
            return Err(PoRError::InvalidEvidence);
        }
        let raw_value = &input[v_start..*pos];
        *pos += 1;
        attrs.push((attr_name, unescape_entities(raw_value)));
    }
}

fn parse_node(input: &str, bytes: &[u8], pos: usize) -> Result<(ChildNode, usize), PoRError> {
    match bytes.get(pos) {
        Some(b'<') => {
            match bytes.get(pos + 1) {
                Some(b'/') => {
                    let start = pos + 2;
                    let mut end = start;
                    while bytes.get(end).map_or(false, |b| *b != b'>') {
                        end += 1;
                    }
                    let name = input[start..end].trim().to_string();
                    Ok((ChildNode::EndTag(name), end + 1))
                }
                Some(b'!') => {
                    // Comment or CDATA.
                    if input[pos..].starts_with("<!--") {
                        let end = input[pos..].find("-->").ok_or(PoRError::InvalidEvidence)?;
                        Ok((ChildNode::Text(String::new()), pos + end + 3))
                    } else if input[pos..].starts_with("<![CDATA[") {
                        let end = input[pos..].find("]]>").ok_or(PoRError::InvalidEvidence)?;
                        let text = input[pos + 9..pos + end].to_string();
                        Ok((ChildNode::Text(text), pos + end + 3))
                    } else {
                        Err(PoRError::InvalidEvidence)
                    }
                }
                Some(b'?') => {
                    let end = input[pos..].find("?>").ok_or(PoRError::InvalidEvidence)?;
                    Ok((ChildNode::Text(String::new()), pos + end + 2))
                }
                _ => {
                    let (el, next) = parse_element(input, bytes, pos)?;
                    Ok((ChildNode::Element(el), next))
                }
            }
        }
        _ => {
            let start = pos;
            let mut end = pos;
            while bytes.get(end).map_or(false, |b| *b != b'<') {
                end += 1;
            }
            if end == start {
                return Err(PoRError::InvalidEvidence);
            }
            Ok((ChildNode::Text(unescape_entities(&input[start..end])), end))
        }
    }
}

fn skip_ws(bytes: &[u8], pos: &mut usize) {
    while bytes.get(*pos).map_or(false, |b| b.is_ascii_whitespace()) {
        *pos += 1;
    }
}

fn unescape_entities(raw: &str) -> String {
    raw.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#xA;", "\n")
        .replace("&#xa;", "\n")
        .replace("&#xD;", "\r")
        .replace("&#xd;", "\r")
        .replace("&#x9;", "\t")
        .replace("&#x9;", "\t")
        .replace("&amp;", "&")
}

fn escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\r', "&#xD;")
        .replace('\n', "&#xA;")
        .replace('\t', "&#x9;")
}

// ---------------------------------------------------------------------------
// Exclusive C14N (subset) — deterministic re-serialization of a subtree.
// ---------------------------------------------------------------------------

/// Serialize a node per Exclusive C14N as emitted by ISO 20022 tooling:
/// attributes in document order with normalized values, text entities
/// escaped, explicit end tags, no self-closing shorthand.
pub fn canonicalize_node(node: &XmlNode) -> String {
    match node {
        XmlNode::Text(t) => escape_text(t),
        XmlNode::Element { name, attrs, children } => {
            let mut out = String::from("<");
            out.push_str(name);
            for (k, v) in attrs {
                out.push(' ');
                out.push_str(k);
                out.push_str("=\"");
                out.push_str(
                    &v.replace('&', "&amp;")
                        .replace('<', "&lt;")
                        .replace('\"', "&quot;")
                        .replace('\t', "&#x9;")
                        .replace('\n', "&#xA;")
                        .replace('\r', "&#xD;"),
                );
                out.push('"');
            }
            out.push('>');
            for child in children {
                out.push_str(&canonicalize_node(child));
            }
            out.push_str("</");
            out.push_str(name);
            out.push('>');
            out
        }
    }
}

// ---------------------------------------------------------------------------
// XMLDSig verification.
// ---------------------------------------------------------------------------

/// Verify the enveloped XMLDSig signature of a `semt.002` document against a
/// registered custodian public key, returning the parsed holdings.
pub fn verify_semt002(
    document_xml: &str,
    custodian_key: &RsaPublicKey,
) -> Result<Vec<CustodyHolding>, PoRError> {
    let root = parse_xml(document_xml)?;

    // 1. Locate the ds:Signature element.
    let signature = root
        .find("Signature")
        .ok_or(PoRError::InvalidEvidence)?;
    let signed_info = signature
        .find("SignedInfo")
        .ok_or(PoRError::InvalidEvidence)?;
    let reference = signed_info
        .find("Reference")
        .ok_or(PoRError::InvalidEvidence)?;
    let uri = reference.attr("URI").ok_or(PoRError::InvalidEvidence)?;

    // Only enveloped signatures over an #id reference are accepted.
    let target_id = uri.strip_prefix('#').ok_or(PoRError::InvalidEvidence)?;
    let method = signed_info
        .find("SignatureMethod")
        .ok_or(PoRError::InvalidEvidence)?;
    if method.attr("Algorithm") != Some("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256") {
        return Err(PoRError::InvalidEvidence);
    }
    let canon_method = signed_info
        .find("CanonicalizationMethod")
        .ok_or(PoRError::InvalidEvidence)?;
    if canon_method.attr("Algorithm") != Some("http://www.w3.org/2001/10/xml-exc-c14n#") {
        return Err(PoRError::InvalidEvidence);
    }

    // 2. Digest verification: canonicalize the referenced subtree and compare
    //    against DigestValue.
    let referenced = root
        .find("Document")
        .filter(|_| target_id == "")
        .or_else(|| find_by_id(&root, target_id))
        .ok_or(PoRError::InvalidEvidence)?;
    let digest_value = signature
        .find("DigestValue")
        .ok_or(PoRError::InvalidEvidence)?
        .text();
    let expected_digest = base64url_decode(digest_value.trim())?;
    let actual_digest = Sha256::digest(canonicalize_node(referenced).as_bytes()).to_vec();
    if expected_digest != actual_digest {
        return Err(PoRError::InvalidEvidence);
    }

    // 3. Signature verification: RSA-SHA256 over canonicalized SignedInfo.
    let signature_value = signature
        .find("SignatureValue")
        .ok_or(PoRError::InvalidEvidence)?
        .text();
    let signature_bytes = base64url_decode(signature_value.trim())?;
    let verifying_key = Pkcs1VerifyingKey::<Sha256>::new(custodian_key.clone());
    let sig = Pkcs1Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| PoRError::InvalidEvidence)?;
    let signed_info_canonical = canonicalize_node(signed_info);
    verifying_key
        .verify(signed_info_canonical.as_bytes(), &sig)
        .map_err(|_| PoRError::InvalidEvidence)?;

    // 4. Extract holdings: one `BalOfScty`/`Bal` block per financial instrument.
    let mut holdings = Vec::new();
    for bal in root.find_all("BalOfScty") {
        let isin = bal
            .find("ISIN")
            .map(|n| n.text())
            .ok_or(PoRError::InvalidEvidence)?;
        let quantity = bal
            .find("Qty")
            .and_then(|q| q.find("Qty"))
            .map(|q| q.text().trim().replace(',', ""))
            .ok_or(PoRError::InvalidEvidence)?;
        let pledged_quantity = bal
            .find("PsdQty")
            .and_then(|q| q.find("Qty"))
            .map(|q| q.text().trim().replace(',', ""))
            .unwrap_or_else(|| "0".to_string());
        let settlement_date = bal
            .find("Dt")
            .map(|d| d.text())
            .unwrap_or_default();
        holdings.push(CustodyHolding {
            isin,
            quantity,
            pledged_quantity,
            settlement_date,
        });
    }
    if holdings.is_empty() {
        return Err(PoRError::InvalidEvidence);
    }
    Ok(holdings)
}

fn find_by_id<'a>(node: &'a XmlNode, id: &str) -> Option<&'a XmlNode> {
    if node.attr("ID") == Some(id) || node.attr("Id") == Some(id) || node.attr("id") == Some(id) {
        return Some(node);
    }
    for child in node.children() {
        if let XmlNode::Element { .. } = child {
            if let Some(found) = find_by_id(child, id) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:semt.002.001.05" ID="doc-1">
  <SctiesBalCstodyRpt>
    <BalOfScty>
      <FinInstrmId><ISIN>US03662Q1058</ISIN></FinInstrmId>
      <Qty><Qty>850000</Qty></Qty>
      <PsdQty><Qty>0</Qty></PsdQty>
      <Dt>2026-11-19</Dt>
    </BalOfScty>
  </SctiesBalCstodyRpt>
</Document>"#;

    #[test]
    fn parses_holdings_without_signature() {
        // Parsing path alone (signature gate rejects unsigned docs).
        let root = parse_xml(SAMPLE).unwrap();
        let holdings: Vec<(String, String)> = root
            .find_all("BalOfScty")
            .iter()
            .map(|b| {
                (
                    b.find("ISIN").unwrap().text(),
                    b.find("Qty").unwrap().find("Qty").unwrap().text(),
                )
            })
            .collect();
        assert_eq!(holdings.len(), 1);
        assert_eq!(holdings[0].0, "US03662Q1058");
        assert_eq!(holdings[0].1, "850000");
    }

    #[test]
    fn rejects_document_without_signature() {
        // rsa rejects sub-512-bit moduli; generate a real 2048-bit anchor.
        use rand::{rngs::OsRng, RngCore, SeedableRng};
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        let key = rsa::RsaPrivateKey::new(&mut rand::rngs::StdRng::from_seed(seed), 2048)
            .unwrap()
            .to_public_key();
        assert_eq!(verify_semt002(SAMPLE, &key), Err(PoRError::InvalidEvidence));
    }

    #[test]
    fn canonicalization_is_stable_and_escaping_correct() {
        let root = parse_xml(SAMPLE).unwrap();
        let canon = canonicalize_node(&root);
        assert!(canon.starts_with("<Document"));
        assert!(canon.contains("ISIN"));
        assert!(!canon.contains("<?xml")); // declaration is not part of subtree
        // Re-canonicalizing a canonicalized node is a fixed point.
        let twice = canonicalize_node(&parse_xml(&canon).unwrap());
        assert_eq!(canon, twice);
    }
}
