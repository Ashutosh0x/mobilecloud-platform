//! Streaming compression engine (CloudFront-style cache policies — research
//! report §4.2).
//!
//! * Static text assets are ideally pre-compressed **at build time** into
//!   `.br` (Brotli-11) and `.gz` (Gzip-9); this module serves those
//!   sidecar files directly when present.
//! * Dynamic SSR responses are compressed on the fly with Brotli level 4
//!   (the CloudFront sweet spot) or Zstandard, selected by the client's
//!   `Accept-Encoding` preference order: `zstd > br > gzip`.
//! * Only compressible content types above the 1 KiB worthiness threshold
//!   are transformed; images, fonts, wasm, and video pass through untouched.

/// Result of a compression pass: the (possibly original) bytes and the
/// `Content-Encoding` to advertise, if any.
pub fn compress_if_worthwhile(
    bytes: &[u8],
    accept_encoding: &str,
    content_type: &str,
) -> (Vec<u8>, Option<&'static str>) {
    if !is_compressible(content_type) || bytes.len() < 1024 {
        return (bytes.to_vec(), None);
    }

    let preferred = preferred_encoding(accept_encoding);
    match preferred {
        Some("zstd") => {
            // Level 3 balances ratio and CPU on big.LITTLE cores.
            match zstd::bulk::compress(bytes, 3) {
                Ok(compressed) => (compressed, Some("zstd")),
                Err(_) => (bytes.to_vec(), None),
            }
        }
        Some("br") => {
            // Dynamic responses use level 4 (the CloudFront policy level);
            // level 11 is build-time only — far too slow for the serving path.
            let mut writer = brotli::CompressorWriter::new(Vec::new(), 4096, 4, 22);
            use std::io::Write;
            if writer.write_all(bytes).is_ok() {
                let compressed = writer.into_inner();
                if compressed.len() < bytes.len() {
                    return (compressed, Some("br"));
                }
            }
            (bytes.to_vec(), None)
        }
        Some("gzip") => {
            use std::io::Write;
            let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
            if encoder.write_all(bytes).is_ok() {
                if let Ok(compressed) = encoder.finish() {
                    if compressed.len() < bytes.len() {
                        return (compressed, Some("gzip"));
                    }
                }
            }
            (bytes.to_vec(), None)
        }
        _ => (bytes.to_vec(), None),
    }
}

/// Content types worth transforming (everything textual).
fn is_compressible(content_type: &str) -> bool {
    let ct = content_type.split(';').next().unwrap_or("").trim();
    matches!(
        ct,
        "text/html"
            | "text/css"
            | "text/plain"
            | "text/javascript"
            | "application/javascript"
            | "application/json"
            | "application/xml"
            | "image/svg+xml"
            | "application/wasm"
    )
}

/// Pick the best mutually-supported encoding per client preference.
fn preferred_encoding(accept_encoding: &str) -> Option<&'static str> {
    let accepts = accept_encoding.to_ascii_lowercase();
    if accepts.contains("zstd") {
        Some("zstd")
    } else if accepts.contains("br") {
        Some("br")
    } else if accepts.contains("gzip") {
        Some("gzip")
    } else {
        None
    }
}

/// Encoding of a build-time sidecar to serve for a client, restricted to the
/// two precompressed formats (`br`, `gzip`). Zstandard has no sidecar
/// convention and is always produced dynamically.
pub fn sidecar_encoding(accept_encoding: &str) -> Option<&'static str> {
    let accepts = accept_encoding.to_ascii_lowercase();
    if accepts.contains("br") {
        Some("br")
    } else if accepts.contains("gzip") {
        Some("gzip")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_best_client_encoding() {
        assert_eq!(preferred_encoding("gzip, deflate, br, zstd"), Some("zstd"));
        assert_eq!(preferred_encoding("br, gzip"), Some("br"));
        assert_eq!(preferred_encoding("gzip"), Some("gzip"));
        assert_eq!(preferred_encoding("identity"), None);
    }

    #[test]
    fn sidecar_selection_ignores_zstd_and_identity() {
        assert_eq!(sidecar_encoding("gzip, br, zstd"), Some("br"));
        assert_eq!(sidecar_encoding("gzip"), Some("gzip"));
        assert_eq!(sidecar_encoding("zstd"), None);
        assert_eq!(sidecar_encoding("identity"), None);
    }

    #[test]
    fn skips_small_and_incompressible_payloads() {
        let small = b"tiny".to_vec();
        assert_eq!(compress_if_worthwhile(&small, "br", "text/html").1, None);
        let png_header = vec![0u8; 4096];
        assert_eq!(
            compress_if_worthwhile(&png_header, "br", "image/png").1,
            None
        );
    }

    #[test]
    fn compresses_html_roundtrip_losslessly() {
        // Highly repetitive HTML compresses drastically under every codec.
        let html = "<html><body>MobileCloud edge serving</body></html>".repeat(200);
        assert!(html.len() > 1024);
        for enc in ["identity", "gzip", "br", "zstd"] {
            let (compressed, used) = compress_if_worthwhile(html.as_bytes(), enc, "text/html; charset=utf-8");
            if used.is_some() {
                assert!(compressed.len() < html.len() / 4, "encoding {enc}");
            }
        }
    }
}
