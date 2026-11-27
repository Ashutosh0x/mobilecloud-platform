# ─────────────────────────────────────────────────────────────
#  MobileCloud Edge — Makefile
# ─────────────────────────────────────────────────────────────

.PHONY: build test relay client keys deploy clean docker

# Default target
all: build test

# ── Build ────────────────────────────────────────────────────

build:
	cargo build -p mobilecloud-tunnel -p mobilecloud-shield

release:
	cargo build --release -p mobilecloud-tunnel -p mobilecloud-shield

# ── Test ─────────────────────────────────────────────────────

test:
	cargo test -p mobilecloud-tunnel -p mobilecloud-shield

# ── Run ──────────────────────────────────────────────────────

relay:
	cargo run --bin mc-tunnel-relay -- \
		--listen-tunnel 0.0.0.0:8443 \
		--listen-public 0.0.0.0:8080 \
		--domain localhost \
		--authorized-key $(KEY)

client:
	cargo run --bin mc-tunnel-client -- \
		--relay ws://127.0.0.1:8443 \
		--client-id dev-phone \
		--signing-key $(KEY) \
		--service console=3210

# ── Keys ─────────────────────────────────────────────────────

keys:
	bash edge/scripts/generate-keys.sh edge/keys

# ── Docker ───────────────────────────────────────────────────

docker:
	docker build -t mobilecloud-relay -f edge/docker/Dockerfile.relay .

docker-up:
	cd edge/docker && docker compose up -d

docker-down:
	cd edge/docker && docker compose down

docker-logs:
	cd edge/docker && docker compose logs -f mc-relay

# ── Deploy ───────────────────────────────────────────────────

deploy:
	@echo "Usage: MC_EMAIL=you@example.com MC_AUTHORIZED_KEY=<hex> MC_DOMAIN=furlpay.com bash edge/scripts/deploy-relay.sh"

# ── Clean ────────────────────────────────────────────────────

clean:
	cargo clean
