//! PKCE (RFC 7636) and the loopback callback used by the browser login.
//!
//! The CLI listens on an ephemeral loopback port, which RFC 8252 §7.3 allows
//! without registering every port. The listener accepts exactly one request,
//! replies with a human-readable page and shuts down. The `state` value is
//! checked before the code is used, so a page that guesses a code cannot
//! complete somebody else's login.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::distributions::Alphanumeric;
use rand::Rng;
use sha2::{Digest, Sha256};

/// A verifier and everything derived from it.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

impl Pkce {
    pub fn new() -> Self {
        let verifier: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(64)
            .map(char::from)
            .collect();
        let state: String = hex::encode(rand::thread_rng().gen::<[u8; 16]>());
        let challenge = challenge_for(&verifier);
        Self { verifier, challenge, state }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Self::new()
    }
}

/// The S256 transformation: base64url(SHA-256(ASCII(verifier))).
pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Waits for the browser to hit `/callback`, then returns the authorization code.
///
/// Blocks the calling thread; the caller has already told the user what to do.
pub fn wait_for_callback(
    listener: TcpListener,
    expected_state: &str,
    timeout: Duration,
) -> Result<String> {
    listener
        .set_nonblocking(true)
        .context("could not configure the local callback listener")?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut socket, _)) => {
                socket.set_nonblocking(false).ok();
                socket.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let request = read_request(&mut socket);
                let target = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or_default()
                    .to_string();
                let query = target.split_once('?').map(|(_, query)| query).unwrap_or_default();
                let params = parse_query(query);
                let parameter = |name: &str| {
                    params
                        .iter()
                        .find(|(key, _)| key == name)
                        .map(|(_, value)| value.clone())
                };
                let denied = parameter("error");
                let code = parameter("code");
                let state = parameter("state").unwrap_or_default();
                if let Some(error) = &denied {
                    respond(&mut socket, "Authorization was denied. You can close this window.");
                    bail!("The browser denied the request ({error}).");
                }
                if state != expected_state {
                    respond(
                        &mut socket,
                        "This response did not match the login that started here. You can close this window.",
                    );
                    bail!("The authorization response did not match this login (state mismatch).");
                }
                respond(&mut socket, "Signed in. You can close this window and return to the terminal.");
                return code.context("The browser returned without an authorization code.");
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error).context("the local callback listener failed"),
        }
    }
    bail!("Timed out waiting for the browser. Run `mobilecloud login` again.")
}

fn read_request(socket: &mut TcpStream) -> String {
    let mut buffer = [0_u8; 8192];
    let read = socket.read(&mut buffer).unwrap_or(0);
    String::from_utf8_lossy(&buffer[..read]).into_owned()
}

fn respond(socket: &mut TcpStream, message: &str) {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>MobileCloud</title>\
         <body style=\"font-family:system-ui;background:#000;color:#ededed;display:grid;place-items:center;height:100vh\">\
         <p>{message}</p>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes());
    let _ = socket.flush();
}

fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((percent_decode(key), percent_decode(value)))
        })
        .collect()
}

/// Minimal `application/x-www-form-urlencoded` decoding. The OAuth values are
/// hex, so this only has to survive `+` and percent escapes.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
                match hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                    Some(byte) => {
                        output.push(byte);
                        index += 3;
                    }
                    None => {
                        output.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&output).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{challenge_for, parse_query, percent_decode};

    #[test]
    fn matches_the_rfc_7636_appendix_b_vector() {
        // The exact verifier/challenge pair from RFC 7636, Appendix B.
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn decodes_a_callback_query() {
        let params = parse_query("code=abc123&state=deadbeef&scope=cli%3Afull");
        assert_eq!(params[0], ("code".to_string(), "abc123".to_string()));
        assert_eq!(params[1], ("state".to_string(), "deadbeef".to_string()));
        assert_eq!(params[2].1, "cli:full");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("100%25"), "100%");
        assert_eq!(percent_decode("broken%2"), "broken%2");
    }
}
