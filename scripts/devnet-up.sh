#!/usr/bin/env bash
# Local isolated devnet (end-to-end testing doc section 1.1): Stellar
# standalone + Soroban RPC, Anvil Arbitrum/Base forks, and the WireMock
# mock custodian/TA service.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/4] Starting Local Stellar Standalone Node with Soroban RPC..."
docker run -d --name stellar-devnet -p 8000:8000 \
  stellar/quickstart:testing --standalone --enable-soroban-rpc

echo "==> [2/4] Starting Anvil EVM Multi-Chain Simulator..."
docker run -d --name anvil-arbitrum -p 8545:8545 \
  ghcr.io/foundry-rs/foundry:latest anvil --port 8545 --chain-id 42161

docker run -d --name anvil-base -p 8546:8545 \
  ghcr.io/foundry-rs/foundry:latest anvil --port 8546 --chain-id 8453

echo "==> [3/4] Launching Mock Custodian Signature Service (WireMock)..."
docker run -d --name mock-custodian -p 8080:8080 \
  -v "$(pwd)/fixtures/wiremock:/home/wiremock" \
  wiremock/wiremock:latest

echo "==> [4/4] Funding Local Deployer Identity via Friendbot..."
curl -s -X POST "http://localhost:8000/friendbot?addr=GDAYU6G4K2EXAMPLE" > /dev/null || true

echo "==> Devnet Online: Stellar RPC @ :8000, Arbitrum @ :8545, Base @ :8546, Custodian @ :8080"
