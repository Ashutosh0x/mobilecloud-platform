# CloudShell

MobileCloud exposes one shell through three surfaces: the on-device Android
app, a browser tab, and a remote SSH client. All three land in the same
`tmux` session, so a build that was started on the phone can be inspected
from a laptop, and a browser reload does not kill it.

```
Android app ──┐
              ├──► PTY supervisor ──► tmux new-session -A -s mobilecloud-session ──► shell
Browser  ─────┤
              │
SSH (russh) ──┘
```

## Surfaces

| Surface | Transport | Credential | Location |
|---|---|---|---|
| Android app | JNI `forkpty` bridge (`libmobilecloud_native.so`) | none (local) | `android-app/app/src/main/kotlin/com/mobilecloud/terminal/` |
| Browser | Axum WebSocket at `/terminal/ws` | one-use ticket | `web-cloudshell/`, `core-engine/src/terminal_gateway/ws_handler.rs` |
| SSH | `russh` daemon on port 2222 | Ed25519 public key | `core-engine/src/terminal_gateway/ssh_server.rs` |

## Authentication

Three separate credentials, because the three surfaces have different
capabilities.

**Operator bearer** — `MOBILECLOUD_OPERATOR_TOKEN`. Grants the full private
operator API. The browser never holds it: anything a page can read, another
page can read too. A trusted gateway in front of the engine attaches it to
same-origin requests. The engine refuses a request whose `Origin` is not the
same host that answered, so a page on another origin cannot spend the
credential even if it stole it.

**Terminal ticket** — a 256-bit opaque value, valid for 30 seconds and
redeemable exactly once. `POST /terminal/ticket` mints it; the browser sends
it in the WebSocket handshake as `?ticket=…`. This is what lets a browser
open a terminal without holding a long-lived credential, and it is why
replaying a captured handshake URL is worthless.

**Preview session** — binds one loopback port for 30 minutes. See
[Web preview](#web-preview).

## Web CloudShell

`web-cloudshell/` is a Vite app that renders [xterm.js](https://xtermjs.org)
with the WebGL renderer. It offers full-duplex input, 10 000 lines of
scrollback, TrueColor, the alternate screen buffer (Vim and `htop` restore
the prompt), OSC 52 clipboard, bracketed paste, and automatic reconnection
with exponential backoff.

### Running it locally

The dev server proxies the engine's routes and attaches the operator
credential, which is the only place that credential appears:

```bash
export MOBILECLOUD_ENGINE=http://127.0.0.1:3000
export MOBILECLOUD_OPERATOR_TOKEN=…          # the engine's operator token
cd web-cloudshell && npm run dev              # http://localhost:5173
```

`vite.config.ts` keeps the browser's `Host` header intact
(`changeOrigin: false`). The engine compares `Origin` against `Host` to
decide whether a request is same-origin, so rewriting the host would make
every browser request look cross-origin.

### Running it in production

The same role is played by the reverse proxy in front of the engine. It must
attach the credential and keep the `Host` header:

```nginx
location ~ ^/(terminal/ticket|api/v1/terminal|api/v1/preview)/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header Authorization "Bearer ${MOBILECLOUD_OPERATOR_TOKEN}";
}
location /terminal/ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
location /preview/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
}
```

The engine's `MOBILECLOUD_TERMINAL_ORIGINS` must list the origin the page
is served from. Same-origin deployments need no configuration; split
deployments do.

## Web preview

Google Cloud Shell exposes a dev server that runs on the machine as a public
URL. MobileCloud does the same for a dev server running on the phone.

```
POST /api/v1/preview/session?port=5173
  → { "port": 5173, "url": "/preview/5173/?token=…", "expires_in": 1800 }

GET /preview/5173/?token=…      → 302 to /preview/5173/ + a session cookie
GET /preview/5173/app.js        → proxied to 127.0.0.1:5173/app.js
```

The proxy is fenced in:

* the upstream is always loopback — no caller-supplied host;
* only high ports are previewable, and the engine's own ports (the operator
  API, the deployment listener, the SSH daemon) are refused;
* the session token is bound to one port, so a link for the dev server does
  not open another port;
* the token is dropped from the URL on the first navigation and exchanged for
  an `HttpOnly` cookie, so it stays out of the address bar, the history
  entry, and any `Referer` the previewed app sends.

`GET /api/v1/preview/ports` lists the loopback ports that currently have a
listener, which is what the CloudShell toolbar shows.

## File transfer

Files move between the phone and the browser over the operator API:

| Route | Purpose |
|---|---|
| `GET /api/v1/terminal/files?path=` | list a directory |
| `POST /api/v1/terminal/upload?path=` | store the request body as a file |
| `GET /api/v1/terminal/download?path=` | read a file back |
| `DELETE /api/v1/terminal/file?path=` | remove a file or directory |

Every path is resolved inside the engine home directory. A path that escapes
it — by traversal, by an absolute path, or through a symlink — is refused
rather than clamped, so the endpoint cannot be used to read another app's
sandbox. Uploads are written to a sibling temporary file and renamed into
place, so an interrupted transfer never leaves a half-written file behind.

## Android session durability

`TerminalSessionService` is a `specialUse` foreground service that pins the
app UID and holds a partial wake lock. It does not own the PTY — the PTY
belongs to the screen that draws it. What it guarantees is that the process,
and therefore the `tmux` server behind the session, is not reclaimed while a
long build is running, so returning to CloudShell re-attaches to the running
session instead of starting a new one.

The wake lock is held only while the service runs, the service runs only
while the user asks for it (the `⏻ KEEP` control), and the lock has a
six-hour timeout so a killed service cannot leave the CPU awake forever.

The reader thread parks in the kernel with `Os.poll(fd, -1)` and watches a
self-pipe, so an idle terminal costs no wake-ups at all.

## SSH

The daemon refuses to start on a non-loopback address unless at least one
Ed25519 key is authorized:

```bash
MOBILECLOUD_SSH_HOST=0.0.0.0 MOBILECLOUD_SSH_PORT=2222 MOBILECLOUD_ENABLE_LOCAL_SSH=1 \
  cargo run -p core-engine
```

`MOBILECLOUD_SSH_BIND` overrides both at once (`host:port`). Passwords are
disabled; only public-key authentication is accepted.
