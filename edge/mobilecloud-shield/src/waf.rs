//! Web Application Firewall (WAF) engine with configurable pattern-matching
//! rules.
//!
//! Ships with [`default_rules`] covering SQL injection, XSS, path traversal,
//! and command injection.  The engine inspects HTTP request parts (URI, headers,
//! query string, body) and returns a [`WafVerdict`].

use std::fmt;

use http::request::Parts;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tracing::warn;

// ───────────────────────────── types ──────────────────────────────

/// Which part of the HTTP request a rule inspects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RuleTarget {
    /// The full request URI / path.
    Url,
    /// All header values concatenated.
    Header,
    /// The request body bytes (UTF-8 lossy).
    Body,
    /// The raw query string.
    QueryString,
}

/// Action to take when a rule matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RuleAction {
    /// Block the request immediately.
    Block,
    /// Log the match but allow the request through.
    Log,
}

/// A single WAF rule.
pub struct WafRule {
    /// Unique rule identifier (e.g. `"sqli-001"`).
    pub id: String,
    /// Human-readable description.
    pub description: String,
    /// Compiled regular expression used for matching.
    pub pattern: Regex,
    /// Which part of the request to inspect.
    pub target: RuleTarget,
    /// What to do when the rule matches.
    pub action: RuleAction,
}

impl fmt::Debug for WafRule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WafRule")
            .field("id", &self.id)
            .field("description", &self.description)
            .field("pattern", &self.pattern.as_str())
            .field("target", &self.target)
            .field("action", &self.action)
            .finish()
    }
}

/// Result of a WAF inspection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WafVerdict {
    /// Request is allowed.
    Allow,
    /// Request is blocked by a specific rule.
    Block {
        /// The rule that triggered the block.
        rule_id: String,
        /// Human-readable reason.
        description: String,
    },
}

// ───────────────────────────── engine ─────────────────────────────

/// The WAF inspection engine.
///
/// Holds an ordered list of [`WafRule`]s and evaluates them against incoming
/// HTTP requests.
#[derive(Debug)]
pub struct WafEngine {
    rules: Vec<WafRule>,
}

/// Percent-decode a URI component (e.g. `%20` → space).
///
/// Attackers routinely percent-encode payloads to evade naive pattern matches,
/// so the engine decodes before matching.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl WafEngine {
    /// Create an engine with the provided rules.
    pub fn new(rules: Vec<WafRule>) -> Self {
        Self { rules }
    }

    /// Create an engine pre-loaded with [`default_rules`].
    pub fn with_defaults() -> Self {
        Self::new(default_rules())
    }

    /// Add a rule to the engine.
    pub fn add_rule(&mut self, rule: WafRule) {
        self.rules.push(rule);
    }

    /// Inspect a request and return a [`WafVerdict`].
    ///
    /// `parts` are the HTTP request head (method, URI, headers).
    /// `body` is an optional reference to the request body bytes.
    pub fn inspect(&self, parts: &Parts, body: Option<&[u8]>) -> WafVerdict {
        for rule in &self.rules {
            let haystack = match rule.target {
                RuleTarget::Url => percent_decode(parts.uri.path()),
                RuleTarget::Header => parts
                    .headers
                    .iter()
                    .map(|(k, v)| {
                        format!("{}: {}", k.as_str(), v.to_str().unwrap_or(""))
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                RuleTarget::Body => body
                    .map(|b| String::from_utf8_lossy(b).into_owned())
                    .unwrap_or_default(),
                RuleTarget::QueryString => percent_decode(parts.uri.query().unwrap_or("")),
            };

            if rule.pattern.is_match(&haystack) {
                match rule.action {
                    RuleAction::Block => {
                        warn!(
                            rule_id = %rule.id,
                            description = %rule.description,
                            target = ?rule.target,
                            "WAF rule matched — blocking request"
                        );
                        return WafVerdict::Block {
                            rule_id: rule.id.clone(),
                            description: rule.description.clone(),
                        };
                    }
                    RuleAction::Log => {
                        warn!(
                            rule_id = %rule.id,
                            description = %rule.description,
                            target = ?rule.target,
                            "WAF rule matched — logging only"
                        );
                        // Continue checking; a later Block rule may still fire.
                    }
                }
            }
        }

        WafVerdict::Allow
    }
}

// ──────────────────────── default rules ──────────────────────────

/// Returns the built-in set of WAF rules covering common attack vectors.
pub fn default_rules() -> Vec<WafRule> {
    vec![
        // ── SQL Injection ────────────────────────────────────────
        WafRule {
            id: "sqli-001".into(),
            description: "SQL injection — UNION SELECT".into(),
            pattern: Regex::new(r"(?i)union\s+(all\s+)?select").unwrap(),
            target: RuleTarget::QueryString,
            action: RuleAction::Block,
        },
        WafRule {
            id: "sqli-002".into(),
            description: "SQL injection — OR 1=1 / tautology".into(),
            pattern: Regex::new(r#"(?i)(\bor\b\s+1\s*=\s*1|\bor\b\s+.?\d+.?\s*=\s*.?\d+)"#).unwrap(),
            target: RuleTarget::QueryString,
            action: RuleAction::Block,
        },
        WafRule {
            id: "sqli-003".into(),
            description: "SQL injection — DROP TABLE".into(),
            pattern: Regex::new(r"(?i)drop\s+table").unwrap(),
            target: RuleTarget::QueryString,
            action: RuleAction::Block,
        },
        WafRule {
            id: "sqli-004".into(),
            description: "SQL injection — common statements".into(),
            pattern: Regex::new(r"(?i)(;\s*(delete|insert|update|alter)\s|--\s|/\*.*\*/)").unwrap(),
            target: RuleTarget::QueryString,
            action: RuleAction::Block,
        },
        // ── XSS ──────────────────────────────────────────────────
        WafRule {
            id: "xss-001".into(),
            description: "XSS — script tag".into(),
            pattern: Regex::new(r"(?i)<\s*script[\s>]").unwrap(),
            target: RuleTarget::QueryString,
            action: RuleAction::Block,
        },
        WafRule {
            id: "xss-002".into(),
            description: "XSS — javascript: URI scheme".into(),
            pattern: Regex::new(r"(?i)javascript\s*:").unwrap(),
            target: RuleTarget::QueryString,
            action: RuleAction::Block,
        },
        WafRule {
            id: "xss-003".into(),
            description: "XSS — event handler attributes".into(),
            pattern: Regex::new(r"(?i)(onerror|onload|onmouseover|onfocus|onblur)\s*=").unwrap(),
            target: RuleTarget::QueryString,
            action: RuleAction::Block,
        },
        WafRule {
            id: "xss-004".into(),
            description: "XSS — script tag in body".into(),
            pattern: Regex::new(r"(?i)<\s*script[\s>]").unwrap(),
            target: RuleTarget::Body,
            action: RuleAction::Block,
        },
        // ── Path Traversal ───────────────────────────────────────
        WafRule {
            id: "traversal-001".into(),
            description: "Path traversal — dot-dot-slash".into(),
            pattern: Regex::new(r"(\.\./|\.\.\\)").unwrap(),
            target: RuleTarget::Url,
            action: RuleAction::Block,
        },
        WafRule {
            id: "traversal-002".into(),
            description: "Path traversal — /etc/passwd".into(),
            pattern: Regex::new(r"/etc/passwd").unwrap(),
            target: RuleTarget::Url,
            action: RuleAction::Block,
        },
        // ── Command Injection ────────────────────────────────────
        WafRule {
            id: "cmdi-001".into(),
            description: "Command injection — shell metacharacters".into(),
            pattern: Regex::new(r"[;|`]|\$\(").unwrap(),
            target: RuleTarget::QueryString,
            action: RuleAction::Block,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::Request;

    fn parts_from_uri(uri: &str) -> Parts {
        let (parts, _body) = Request::builder()
            .uri(uri)
            .body(())
            .unwrap()
            .into_parts();
        parts
    }

    #[test]
    fn blocks_sql_injection() {
        let engine = WafEngine::with_defaults();
        let parts = parts_from_uri("/?q=1%20UNION%20SELECT%20*%20FROM%20users");
        assert!(matches!(engine.inspect(&parts, None), WafVerdict::Block { .. }));
    }

    #[test]
    fn allows_clean_request() {
        let engine = WafEngine::with_defaults();
        let parts = parts_from_uri("/api/health?check=true");
        assert_eq!(engine.inspect(&parts, None), WafVerdict::Allow);
    }

    #[test]
    fn blocks_path_traversal() {
        let engine = WafEngine::with_defaults();
        let parts = parts_from_uri("/static/../../etc/passwd");
        assert!(matches!(engine.inspect(&parts, None), WafVerdict::Block { .. }));
    }

    #[test]
    fn blocks_xss_in_body() {
        let engine = WafEngine::with_defaults();
        let parts = parts_from_uri("/submit");
        let body = b"<script>alert('xss')</script>";
        assert!(matches!(engine.inspect(&parts, Some(body)), WafVerdict::Block { .. }));
    }
}
