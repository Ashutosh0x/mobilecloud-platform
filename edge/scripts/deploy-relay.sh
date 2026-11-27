#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  MobileCloud — Relay VPS Deployment Script
# ─────────────────────────────────────────────────────────────────
#  Deploys the MobileCloud tunnel relay to a fresh Ubuntu 22.04+ VPS.
#
#  What it does:
#    1. Installs Rust toolchain (if missing)
#    2. Builds the relay binary
#    3. Creates systemd service
#    4. Configures UFW firewall
#    5. Sets up TLS with Let's Encrypt (certbot)
#
#  Usage:
#    ssh root@your-vps "bash -s" < scripts/deploy-relay.sh
#    # — or —
#    scp -r edge/ root@your-vps:/opt/mobilecloud/
#    ssh root@your-vps /opt/mobilecloud/edge/scripts/deploy-relay.sh
#
#  Environment variables:
#    MC_DOMAIN          — Domain name (default: furlpay.com)
#    MC_EMAIL           — Email for Let's Encrypt (required)
#    MC_AUTHORIZED_KEY  — Hex-encoded Ed25519 public key (required)
#    MC_TUNNEL_PORT     — Tunnel listener port (default: 8443)
#    MC_PUBLIC_PORT     — Public HTTP port (default: 8080)
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuration ───────────────────────────────────────────────

DOMAIN="${MC_DOMAIN:-furlpay.com}"
EMAIL="${MC_EMAIL:?MC_EMAIL must be set for Let's Encrypt}"
AUTHORIZED_KEY="${MC_AUTHORIZED_KEY:?MC_AUTHORIZED_KEY must be set}"
TUNNEL_PORT="${MC_TUNNEL_PORT:-8443}"
PUBLIC_PORT="${MC_PUBLIC_PORT:-8080}"

INSTALL_DIR="/opt/mobilecloud"
CONFIG_DIR="/etc/mobilecloud"
LOG_DIR="/var/log/mobilecloud"
USER="mobilecloud"

echo "╔══════════════════════════════════════════════════╗"
echo "║   MobileCloud Relay — VPS Deployment            ║"
echo "╚══════════════════════════════════════════════════╝"
echo "  Domain:         $DOMAIN"
echo "  Tunnel port:    $TUNNEL_PORT"
echo "  Public port:    $PUBLIC_PORT"
echo

# ── 0. System packages ─────────────────────────────────────────

echo "→ Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq build-essential pkg-config libssl-dev curl ufw certbot >/dev/null

# ── 1. Create service user ──────────────────────────────────────

if ! id "$USER" &>/dev/null; then
    useradd --system --shell /usr/sbin/nologin --home-dir "$INSTALL_DIR" "$USER"
    echo "✔ Created system user: $USER"
fi

# ── 2. Install Rust ────────────────────────────────────────────

if ! command -v cargo &>/dev/null; then
    echo "→ Installing Rust toolchain..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    source "$HOME/.cargo/env"
fi
echo "✔ Rust: $(rustc --version)"

# ── 3. Build the relay ─────────────────────────────────────────

echo "→ Building mc-tunnel-relay..."
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

if [ -d "edge" ]; then
    cd edge/..
    cargo build --release -p mobilecloud-tunnel 2>&1
else
    echo "ERROR: edge/ directory not found in $INSTALL_DIR"
    echo "Please copy the project to $INSTALL_DIR first."
    exit 1
fi

cp target/release/mc-tunnel-relay /usr/local/bin/mc-tunnel-relay
chmod +x /usr/local/bin/mc-tunnel-relay
echo "✔ Binary installed: /usr/local/bin/mc-tunnel-relay"

# ── 4. Configuration ───────────────────────────────────────────

mkdir -p "$CONFIG_DIR" "$LOG_DIR"

cat > "$CONFIG_DIR/relay.env" <<EOF
MC_TUNNEL_ADDR=0.0.0.0:${TUNNEL_PORT}
MC_PUBLIC_ADDR=0.0.0.0:${PUBLIC_PORT}
MC_DOMAIN=${DOMAIN}
# Add more keys separated by space if needed
AUTHORIZED_KEYS=${AUTHORIZED_KEY}
RUST_LOG=info
EOF

echo "✔ Config written: $CONFIG_DIR/relay.env"

# ── 5. Systemd service ─────────────────────────────────────────

cat > /etc/systemd/system/mc-relay.service <<EOF
[Unit]
Description=MobileCloud Tunnel Relay
After=network-online.target
Wants=network-online.target
Documentation=https://github.com/Ashutosh0x/mobilecloud-platform

[Service]
Type=simple
User=${USER}
Group=${USER}
EnvironmentFile=${CONFIG_DIR}/relay.env
ExecStart=/usr/local/bin/mc-tunnel-relay \\
    --listen-tunnel \${MC_TUNNEL_ADDR} \\
    --listen-public \${MC_PUBLIC_ADDR} \\
    --domain \${MC_DOMAIN} \\
    --authorized-key \${AUTHORIZED_KEYS}
Restart=always
RestartSec=5
LimitNOFILE=65535
StandardOutput=journal
StandardError=journal

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadOnlyPaths=/
ReadWritePaths=${LOG_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mc-relay.service
echo "✔ Systemd service installed and enabled"

# ── 6. Firewall ─────────────────────────────────────────────────

echo "→ Configuring UFW firewall..."
ufw allow 22/tcp     comment "SSH"
ufw allow 80/tcp     comment "HTTP (certbot)"
ufw allow 443/tcp    comment "HTTPS"
ufw allow "${TUNNEL_PORT}/tcp" comment "MobileCloud tunnel"
ufw allow "${PUBLIC_PORT}/tcp" comment "MobileCloud public"
ufw --force enable
echo "✔ Firewall configured"

# ── 7. TLS certificate ─────────────────────────────────────────

echo "→ Obtaining TLS certificate for *.${DOMAIN}..."
certbot certonly --standalone \
    -d "${DOMAIN}" \
    -d "*.${DOMAIN}" \
    --email "${EMAIL}" \
    --agree-tos \
    --non-interactive \
    --preferred-challenges http || {
    echo "⚠  Certbot failed — you may need to use DNS challenge for wildcard certs."
    echo "   Run: certbot certonly --manual --preferred-challenges dns -d '*.${DOMAIN}'"
}

# ── 8. Start the relay ──────────────────────────────────────────

echo "→ Starting mc-relay service..."
systemctl start mc-relay.service
sleep 2
systemctl status mc-relay.service --no-pager

echo
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✔ MobileCloud Relay deployed successfully!    ║"
echo "╚══════════════════════════════════════════════════╝"
echo
echo "  Tunnel:  ws://0.0.0.0:${TUNNEL_PORT}"
echo "  Public:  http://0.0.0.0:${PUBLIC_PORT}"
echo "  Logs:    journalctl -u mc-relay -f"
echo "  Status:  systemctl status mc-relay"
