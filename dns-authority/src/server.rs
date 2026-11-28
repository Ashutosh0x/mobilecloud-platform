//! The authoritative listeners: UDP on port 53 and TCP on port 53.
//!
//! Both transports share one `answer` function so a question cannot be answered
//! differently depending on how it arrived. Truncation follows the DNS rules:
//! a UDP response over the advertised limit is returned with the TC bit set and
//! an empty answer section so the client retries over TCP.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};

use crate::metrics::Transport;
use crate::resolver::AuthoritativeResolver;
use crate::store::DnsStore;
use crate::wire::{self, Header, Message, RCODE_FORMERR, RCODE_NOTIMP};

/// Largest client datagram we will read.
const MAX_UDP_REQUEST: usize = 4096;
/// Classic pre-EDNS UDP payload size.
const UDP_RESPONSE_LIMIT: usize = 512;
/// EDNS(0) UDP payload size we honour when the client asks for one.
const EDNS_UDP_RESPONSE_LIMIT: usize = 1232;

/// Turn one parsed query into the response message we will send.
pub async fn answer<S: DnsStore + 'static>(
    resolver: &AuthoritativeResolver<S>,
    query: &Message,
    client: Option<Ipv4Addr>,
) -> Message {
    let mut header = Header::new_query(query.header.id, query.header.recursion_desired());
    header.set_response();
    header.set_authoritative();

    let mut response = Message {
        header,
        questions: query.questions.clone(),
        answers: Vec::new(),
        authorities: Vec::new(),
        additionals: Vec::new(),
    };

    // Someone sent us a response. Refusing to reflect it is the safe default.
    if query.header.qr() {
        response.questions.clear();
        response.header.set_rcode(RCODE_FORMERR);
        return response;
    }
    if query.header.opcode() != wire::OPCODE_QUERY {
        response.header.set_rcode(RCODE_NOTIMP);
        return response;
    }
    if query.questions.len() != 1 {
        response.header.set_rcode(RCODE_FORMERR);
        return response;
    }

    let outcome = resolver.resolve(&query.questions[0], client).await;
    response.header.set_rcode(outcome.rcode);
    response.answers = outcome.answers;
    response.authorities = outcome.authorities;
    response
}

/// Encode a response within `limit` octets, setting TC and dropping the answer
/// sections when it does not fit. Returns the bytes and whether it truncated.
pub fn encode_limited(response: &Message, limit: usize) -> (Vec<u8>, bool) {
    if let Ok(bytes) = response.encode() {
        if bytes.len() <= limit {
            return (bytes, false);
        }
    }
    let mut truncated = response.clone();
    truncated.answers.clear();
    truncated.authorities.clear();
    truncated.additionals.clear();
    truncated.header.flags |= 0x0200; // TC
    (truncated.encode().unwrap_or_default(), true)
}

/// The largest UDP response this client is willing to receive.
fn udp_limit(query: &Message) -> usize {
    if query.additionals.iter().any(|rr| rr.rtype == wire::TYPE_OPT) {
        EDNS_UDP_RESPONSE_LIMIT
    } else {
        UDP_RESPONSE_LIMIT
    }
}

fn client_of(peer: SocketAddr) -> Option<Ipv4Addr> {
    match peer.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}

/// Serve DNS over UDP until the task is cancelled.
pub async fn serve_udp<S: DnsStore + 'static>(
    resolver: Arc<AuthoritativeResolver<S>>,
    socket: UdpSocket,
) {
    let metrics = resolver.metrics().clone();
    let mut buf = vec![0u8; MAX_UDP_REQUEST];
    loop {
        let (len, peer) = match socket.recv_from(&mut buf).await {
            Ok(received) => received,
            Err(error) => {
                tracing::warn!(%error, "udp receive failed");
                continue;
            }
        };
        let query = match Message::parse(&buf[..len]) {
            Ok(query) => query,
            Err(error) => {
                tracing::debug!(%error, %peer, "dropping unparseable udp datagram");
                metrics.record_malformed();
                continue;
            }
        };
        metrics.record_transport(Transport::Udp);
        let response = answer(&resolver, &query, client_of(peer)).await;
        let (bytes, was_truncated) = encode_limited(&response, udp_limit(&query));
        if was_truncated {
            metrics.record_truncated();
        }
        if let Err(error) = socket.send_to(&bytes, peer).await {
            tracing::warn!(%error, %peer, "udp send failed");
        }
    }
}

/// Accept TCP connections and serve them concurrently.
pub async fn serve_tcp<S: DnsStore + 'static>(
    resolver: Arc<AuthoritativeResolver<S>>,
    listener: TcpListener,
) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                tracing::warn!(%error, "tcp accept failed");
                continue;
            }
        };
        let resolver = resolver.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_tcp(resolver, stream, peer).await {
                tracing::debug!(%error, %peer, "tcp session closed");
            }
        });
    }
}

async fn handle_tcp<S: DnsStore + 'static>(
    resolver: Arc<AuthoritativeResolver<S>>,
    mut stream: TcpStream,
    peer: SocketAddr,
) -> std::io::Result<()> {
    let metrics = resolver.metrics().clone();
    let client = client_of(peer);
    loop {
        let mut length = [0u8; 2];
        match stream.read_exact(&mut length).await {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error),
        }
        let length = u16::from_be_bytes(length) as usize;
        if length == 0 {
            return Ok(());
        }
        let mut frame = vec![0u8; length];
        stream.read_exact(&mut frame).await?;
        let query = match Message::parse(&frame) {
            Ok(query) => query,
            Err(error) => {
                tracing::debug!(%error, %peer, "dropping unparseable tcp message");
                metrics.record_malformed();
                continue;
            }
        };
        metrics.record_transport(Transport::Tcp);
        let response = answer(&resolver, &query, client).await;
        // A TCP message carries a 16-bit length, so that is the hard ceiling.
        let (bytes, was_truncated) = encode_limited(&response, u16::MAX as usize);
        if was_truncated {
            metrics.record_truncated();
        }
        stream.write_all(&(bytes.len() as u16).to_be_bytes()).await?;
        stream.write_all(&bytes).await?;
    }
}

/// Bind both transports and serve until the process exits.
pub async fn run<S: DnsStore + 'static>(
    resolver: Arc<AuthoritativeResolver<S>>,
    udp: SocketAddr,
    tcp: SocketAddr,
) -> std::io::Result<()> {
    let udp_socket = UdpSocket::bind(udp).await?;
    let tcp_listener = TcpListener::bind(tcp).await?;
    let udp_task = tokio::spawn(serve_udp(resolver.clone(), udp_socket));
    let tcp_task = tokio::spawn(serve_tcp(resolver, tcp_listener));
    let _ = tokio::join!(udp_task, tcp_task);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geo::GeoRouter;
    use crate::metrics::Metrics;
    use crate::record::{Record, RecordType};
    use crate::store::{MemoryStore, Zone};
    use crate::wire::{Question, RData, ResourceRecord, TYPE_A, TYPE_TXT};

    async fn resolver() -> Arc<AuthoritativeResolver<MemoryStore>> {
        let store = Arc::new(MemoryStore::new());
        store.create_zone(Zone::new("furlpay.com", "owner")).await.unwrap();
        store
            .put_record(
                Record::new("furlpay.com", "@", RecordType::A, "203.0.113.10", 300, None, false)
                    .unwrap(),
            )
            .await
            .unwrap();
        Arc::new(AuthoritativeResolver::new(
            store,
            Arc::new(GeoRouter::default()),
            Arc::new(Metrics::new()),
        ))
    }

    #[tokio::test]
    async fn builds_an_authoritative_response() {
        let resolver = resolver().await;
        let mut query = Message::new(0x1234);
        query.header = Header::new_query(0x1234, true);
        query.questions.push(Question::new("furlpay.com", TYPE_A));

        let response = answer(&resolver, &query, None).await;
        assert_eq!(response.header.id, 0x1234);
        assert!(response.header.qr());
        assert!(response.header.authoritative());
        assert!(response.header.recursion_desired());
        assert_eq!(response.header.rcode(), wire::RCODE_NOERROR);
        assert_eq!(response.answers.len(), 1);
    }

    #[tokio::test]
    async fn recognises_an_answer_as_our_own_response() {
        let resolver = resolver().await;
        let mut query = Message::new(1);
        query.header.set_response();
        query.questions.push(Question::new("furlpay.com", TYPE_A));
        let response = answer(&resolver, &query, None).await;
        assert_eq!(response.header.rcode(), RCODE_FORMERR);
        assert!(response.questions.is_empty());
    }

    #[tokio::test]
    async fn formerr_for_multiple_questions() {
        let resolver = resolver().await;
        let mut query = Message::new(1);
        query.questions.push(Question::new("furlpay.com", TYPE_A));
        query.questions.push(Question::new("furlpay.com", TYPE_TXT));
        let response = answer(&resolver, &query, None).await;
        assert_eq!(response.header.rcode(), RCODE_FORMERR);
    }

    #[tokio::test]
    async fn notimp_for_a_non_query_opcode() {
        let resolver = resolver().await;
        let mut query = Message::new(1);
        query.header.flags = 0x2800; // opcode 5
        let response = answer(&resolver, &query, None).await;
        assert_eq!(response.header.rcode(), RCODE_NOTIMP);
    }

    #[test]
    fn truncates_only_when_over_the_limit() {
        let mut response = Message::new(1);
        response.header.set_response();
        response.questions.push(Question::new("furlpay.com", TYPE_A));
        for octet in 1..=40u8 {
            response.answers.push(ResourceRecord::new(
                &format!("n{octet}.furlpay.com"),
                300,
                RData::A(format!("203.0.113.{octet}").parse().unwrap()),
            ));
        }

        let (fits, truncated) = encode_limited(&response, 4096);
        assert!(!truncated);
        assert!(!fits.is_empty());

        let (small, truncated) = encode_limited(&response, 512);
        assert!(truncated);
        assert!(small.len() <= 512);
        let parsed = Message::parse(&small).unwrap();
        assert!(parsed.header.truncated());
        assert!(parsed.answers.is_empty());
        assert_eq!(parsed.questions.len(), 1);
    }

    #[test]
    fn edns_raises_the_udp_limit() {
        let mut plain = Message::new(1);
        plain.questions.push(Question::new("furlpay.com", TYPE_A));
        assert_eq!(udp_limit(&plain), UDP_RESPONSE_LIMIT);

        let mut edns = Message::new(2);
        edns.additionals.push(ResourceRecord {
            name: String::new(),
            rtype: wire::TYPE_OPT,
            class: 4096,
            ttl: 0,
            rdata: RData::Raw(Vec::new()),
        });
        assert_eq!(udp_limit(&edns), EDNS_UDP_RESPONSE_LIMIT);
    }

    #[tokio::test]
    async fn round_trips_a_query_over_a_real_udp_socket() {
        let resolver = resolver().await;
        let socket = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
        let server_addr = socket.local_addr().expect("addr");
        let server = tokio::spawn(serve_udp(resolver, socket));

        let client = UdpSocket::bind("127.0.0.1:0").await.expect("bind client");
        let mut query = Message::new(0xBEEF);
        query.header = Header::new_query(0xBEEF, true);
        query.questions.push(Question::new("furlpay.com", TYPE_A));
        let wire_bytes = query.encode().expect("encode");
        client.send_to(&wire_bytes, server_addr).await.expect("send");

        let mut buf = [0u8; 512];
        let (len, _) = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            client.recv_from(&mut buf),
        )
        .await
        .expect("server answered in time")
        .expect("recv");
        let response = Message::parse(&buf[..len]).expect("parse response");
        assert_eq!(response.header.id, 0xBEEF);
        assert_eq!(response.header.rcode(), wire::RCODE_NOERROR);
        assert_eq!(response.answers.len(), 1);

        server.abort();
    }
}
