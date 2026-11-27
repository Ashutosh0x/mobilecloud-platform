//! WebSocket-to-yamux multiplexer adapter.
//!
//! Wraps a WebSocket connection with yamux stream multiplexing so that
//! multiple concurrent TCP-like streams can share a single WebSocket tunnel.
//!
//! yamux 0.10 operates over the `futures-io` traits (`futures::io::AsyncRead`
//! / `AsyncWrite`), so [`WebSocketAdapter`] implements those. The inner
//! transport is whatever `tokio-tungstenite` uses — a plain `TcpStream` on the
//! relay side, or a `MaybeTlsStream<TcpStream>` on the client side — hence the
//! generic parameter `S`.

use bytes::BytesMut;
use futures_io::{AsyncRead, AsyncWrite};
use futures_util::{Sink, Stream};
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead as TokioRead, AsyncWrite as TokioWrite};
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};

/// Adapts a WebSocket stream to implement `futures_io::AsyncRead + AsyncWrite`,
/// so it can be used as the transport layer for yamux.
pub struct WebSocketAdapter<S> {
    inner: WebSocketStream<S>,
    read_buf: BytesMut,
}

impl<S> WebSocketAdapter<S> {
    /// Wrap a WebSocket stream.
    pub fn new(ws: WebSocketStream<S>) -> Self {
        Self {
            inner: ws,
            read_buf: BytesMut::with_capacity(8192),
        }
    }

    /// Wrap a reunited WebSocket stream (after split + reunite).
    ///
    /// This is used by the relay after performing the text-based handshake
    /// on split halves, then reuniting them before switching to yamux binary mode.
    pub fn new_from_reunited(ws: WebSocketStream<S>) -> Self {
        Self::new(ws)
    }
}

impl<S> AsyncRead for WebSocketAdapter<S>
where
    S: TokioRead + TokioWrite + Unpin,
{
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        // Drain buffered data first
        if !self.read_buf.is_empty() {
            let len = std::cmp::min(buf.len(), self.read_buf.len());
            buf[..len].copy_from_slice(&self.read_buf.split_to(len));
            return Poll::Ready(Ok(len));
        }

        // Poll the WebSocket for the next message
        match Pin::new(&mut self.inner).poll_next(cx) {
            Poll::Ready(Some(Ok(Message::Binary(data)))) => {
                let len = std::cmp::min(buf.len(), data.len());
                buf[..len].copy_from_slice(&data[..len]);
                if len < data.len() {
                    self.read_buf.extend_from_slice(&data[len..]);
                }
                Poll::Ready(Ok(len))
            }
            Poll::Ready(Some(Ok(Message::Close(_)))) | Poll::Ready(None) => {
                Poll::Ready(Ok(0)) // EOF
            }
            Poll::Ready(Some(Ok(_))) => {
                // Skip non-binary messages (ping/pong/text)
                cx.waker().wake_by_ref();
                Poll::Pending
            }
            Poll::Ready(Some(Err(e))) => {
                Poll::Ready(Err(io::Error::new(io::ErrorKind::Other, e.to_string())))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<S> AsyncWrite for WebSocketAdapter<S>
where
    S: TokioRead + TokioWrite + Unpin,
{
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let msg = Message::Binary(buf.to_vec().into());
        match Pin::new(&mut self.inner).poll_ready(cx) {
            Poll::Ready(Ok(())) => {
                match Pin::new(&mut self.inner).start_send(msg) {
                    Ok(()) => Poll::Ready(Ok(buf.len())),
                    Err(e) => Poll::Ready(Err(io::Error::new(io::ErrorKind::Other, e.to_string()))),
                }
            }
            Poll::Ready(Err(e)) => {
                Poll::Ready(Err(io::Error::new(io::ErrorKind::Other, e.to_string())))
            }
            Poll::Pending => Poll::Pending,
        }
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner)
            .poll_flush(cx)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))
    }

    fn poll_close(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner)
            .poll_close(cx)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))
    }
}

/// Direction of the yamux connection.
#[derive(Debug, Clone, Copy)]
pub enum YamuxMode {
    /// Client mode — opens outbound streams.
    Client,
    /// Server mode — accepts inbound streams.
    Server,
}

/// A thin wrapper around a yamux `Connection` operating over a WebSocket.
///
/// Provides stream multiplexing: many logical TCP-like streams share
/// a single WebSocket tunnel connection.
pub struct TunnelMux {
    control: yamux::Control,
    _mode: YamuxMode,
}

impl TunnelMux {
    /// Create a new yamux multiplexer over the given WebSocket adapter.
    ///
    /// Returns the `TunnelMux` for stream management and the yamux
    /// `Connection` that must be driven (e.g. via `next_stream`) to make
    /// progress.
    pub fn new<S>(
        ws_adapter: WebSocketAdapter<S>,
        mode: YamuxMode,
    ) -> (Self, yamux::Connection<WebSocketAdapter<S>>)
    where
        S: TokioRead + TokioWrite + Unpin + Send + 'static,
    {
        let mut cfg = yamux::Config::default();
        cfg.set_max_buffer_size(16 * 1024 * 1024); // 16 MiB

        let conn = match mode {
            YamuxMode::Client => {
                yamux::Connection::new(ws_adapter, cfg, yamux::Mode::Client)
            }
            YamuxMode::Server => {
                yamux::Connection::new(ws_adapter, cfg, yamux::Mode::Server)
            }
        };

        let control = conn.control();

        (
            Self {
                control,
                _mode: mode,
            },
            conn,
        )
    }

    /// Open a new outbound yamux stream (client side).
    pub async fn open_stream(&mut self) -> anyhow::Result<yamux::Stream> {
        self.control
            .open_stream()
            .await
            .map_err(|e| anyhow::anyhow!("failed to open yamux stream: {e}"))
    }

    /// Close the yamux connection gracefully.
    pub async fn close(&mut self) -> anyhow::Result<()> {
        self.control
            .close()
            .await
            .map_err(|e| anyhow::anyhow!("failed to close yamux connection: {e}"))
    }
}
