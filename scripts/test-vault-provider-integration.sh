#!/usr/bin/env bash
# test-vault-provider-integration.sh -- run the HashiCorp Vault provider
# integration tests against a throwaway real Vault (same version as production).
#
# Starts hashicorp/vault in dev mode (KV v2 at secret/), installs a policy shaped
# like production's app policy (managed prefix: create/read/update + metadata
# create/read/update -- `create` is required to set max_versions on a NEW key,
# proven by this test on 2026-10-25 -- + soft delete; external path read-only; NO destroy, NO patch),
# mints a token carrying only that policy, seeds an external fixture, and runs
# server/src/__tests__/vault-provider.integration.test.ts.
#
# Needs: docker whose published ports are reachable from this host (e.g. the
# gpu build host, not the devcontainer's sidecar daemon), node 24 + pnpm deps.
# Usage: scripts/test-vault-provider-integration.sh [vault-image]
set -euo pipefail
IMAGE="${1:-hashicorp/vault:1.21.2}"
cd "$(dirname "$0")/.."
NAME="paperclip-vault-it-$$"
PORT="${PAPERCLIP_TEST_VAULT_PORT:-$(( 20000 + RANDOM % 20000 ))}"
WORK="$(mktemp -d)"; chmod 700 "$WORK"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
command -v docker >/dev/null || { echo "docker is required" >&2; exit 69; }

docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:8200" -e VAULT_DEV_ROOT_TOKEN_ID=it-root "$IMAGE" >/dev/null
root() { docker exec -i -e VAULT_TOKEN=it-root -e VAULT_ADDR=http://127.0.0.1:8200 "$NAME" "$@"; }
for _ in $(seq 1 30); do root vault status >/dev/null 2>&1 && break; sleep 1; done
root vault status >/dev/null || { echo "Vault did not start" >&2; exit 1; }

root vault policy write paperclip-secrets - >/dev/null <<'HCL'
path "secret/data/t6-apps/bionic-org/paperclip/*" { capabilities = ["create", "read", "update"] }
path "secret/metadata/t6-apps/bionic-org/paperclip/*" { capabilities = ["create", "read", "update"] }
path "secret/delete/t6-apps/bionic-org/paperclip/*" { capabilities = ["update"] }
path "secret/data/t6-apps/bionic-org/sandbox" { capabilities = ["read"] }
HCL
root vault kv put secret/t6-apps/bionic-org/sandbox brev_ssh_private_key=sandbox-key-fixture >/dev/null
root vault kv put secret/t6-apps/bionic-org/config paperclip_secrets_master_key=must-not-be-readable >/dev/null
root vault token create -policy=paperclip-secrets -ttl=1h -field=token > "$WORK/token"
chmod 600 "$WORK/token"

export PAPERCLIP_TEST_VAULT_ADDR="http://127.0.0.1:${PORT}"
export PAPERCLIP_TEST_VAULT_TOKEN_FILE="$WORK/token"
cd server
timeout 600 npx vitest run src/__tests__/vault-provider.integration.test.ts
