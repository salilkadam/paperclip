#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-vault-secrets.sh — Populate Vault with Bionic Org secrets
#
# Creates/updates the secret at t6-apps/bionic-org/config in Vault
# with all required environment variables.
#
# IMPORTANT (learned the hard way, 2026-10-06):
#  1. This script MERGES into the existing secret (kv patch). Never use
#     `kv put`/`vault write` here — KV v2 writes REPLACE the whole object and
#     silently delete keys you did not pass (this bit us once already).
#  2. paperclip_secrets_master_key is the AES-256-GCM master key for the
#     `local_encrypted` secrets provider. It is generated exactly ONCE and must
#     never be regenerated while any encrypted secret version exists in the
#     database — regenerating it makes all managed secrets (agent API keys,
#     OAuth tokens…) permanently undecryptable. This script preserves the
#     existing value; pass --rotate-master-key ONLY when you intend to wipe and
#     re-enter every managed secret in the Board UI.
#
# Usage:
#   ./deploy/scripts/setup-vault-secrets.sh \
#     --database-url "postgresql://..." \
#     --better-auth-secret "..." \
#     --session-secret "..." \
#     --keycloak-client-id "..." \
#     --keycloak-client-secret "..." \
#     [--minio-root-user "..."] [--minio-root-password "..."] \
#     [--rotate-master-key]
#
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

VAULT_PATH="t6-apps/bionic-org/config"
VAULT_MOUNT="secret"
MASTER_KEY_KEY="paperclip_secrets_master_key"
ROTATE_MASTER_KEY=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --database-url)          DATABASE_URL="$2"; shift 2 ;;
    --better-auth-secret)    BETTER_AUTH_SECRET="$2"; shift 2 ;;
    --session-secret)        SESSION_SECRET="$2"; shift 2 ;;
    --keycloak-client-id)    KEYCLOAK_CLIENT_ID="$2"; shift 2 ;;
    --keycloak-client-secret) KEYCLOAK_CLIENT_SECRET="$2"; shift 2 ;;
    --minio-root-user)       MINIO_ROOT_USER="$2"; shift 2 ;;
    --minio-root-password)   MINIO_ROOT_PASSWORD="$2"; shift 2 ;;
    --rotate-master-key)     ROTATE_MASTER_KEY=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "=== Populating Vault secrets (merge, never replace) ==="
echo "  Path    : ${VAULT_PATH}"
echo ""

if ! command -v vault &> /dev/null; then
  echo "  vault CLI not found. Use the Vault UI or API directly."
  echo "  Path: ${VAULT_PATH} (KV v2 mount: ${VAULT_MOUNT})"
  echo "  Required keys:"
  echo "    - database_url, better_auth_secret, session_secret"
  echo "    - keycloak_client_id, keycloak_client_secret"
  echo "    - minio_root_user, minio_root_password"
  echo "    - ${MASTER_KEY_KEY}  (base64 of a 32-byte key; generate ONCE:"
  echo "        openssl rand -base64 32)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Master key: read existing first. Preserve unless explicitly rotating.
# ---------------------------------------------------------------------------
EXISTING_MASTER_KEY=""
# A failed READ must never look like "no existing key": that would generate a
# new master key and patch it over the real one (every encrypted secret lost).
# Only Vault's explicit "No value found" means the path is new.
if ! EXISTING_JSON=$(vault kv get -mount="${VAULT_MOUNT}" -format=json "${VAULT_PATH}" 2>"${TMPDIR:-/tmp}/vault-read.err"); then
  if grep -q "No value found" "${TMPDIR:-/tmp}/vault-read.err"; then
    EXISTING_JSON=""
  else
    echo "ERROR: cannot read ${VAULT_MOUNT}/${VAULT_PATH}: $(tail -1 "${TMPDIR:-/tmp}/vault-read.err")" >&2
    echo "Refusing to continue: a failed read would regenerate the master key." >&2
    exit 1
  fi
fi
rm -f "${TMPDIR:-/tmp}/vault-read.err"
if [[ -n "${EXISTING_JSON}" ]]; then
  EXISTING_MASTER_KEY=$(printf '%s' "${EXISTING_JSON}" \
    | jq -r --arg k "${MASTER_KEY_KEY}" '.data.data[$k] // empty')
fi

if [[ "${ROTATE_MASTER_KEY}" == true ]]; then
  echo "  !! Rotating master key. ALL existing encrypted secrets in the Paperclip"
  echo "  !! database will become undecryptable and MUST be re-entered in the UI."
  read -r -p "  Type 'rotate' to continue: " CONFIRM
  [[ "${CONFIRM}" == "rotate" ]] || { echo "Aborted."; exit 1; }
  MASTER_KEY=$(openssl rand -base64 32)
elif [[ -n "${EXISTING_MASTER_KEY}" ]]; then
  MASTER_KEY="${EXISTING_MASTER_KEY}"
  echo "  Master key: preserved existing value."
else
  MASTER_KEY=$(openssl rand -base64 32)
  echo "  Master key: generated NEW key (first time for this Vault path)."
  echo "  !! Back it up off-cluster now; losing it loses all managed secrets."
fi

# ---------------------------------------------------------------------------
# Build the patch payload (only provided keys are written; others untouched).
# ---------------------------------------------------------------------------
# Tool-action signing secret (signs "ask first" approval cards for Apps v2
# connections, e.g. the Ghost blogs). Generated once and preserved: rotating it
# invalidates approvals that are still pending.
SIGNING_KEY_KEY="tool_action_signing_secret"
EXISTING_SIGNING=""
if [[ -n "${EXISTING_JSON:-}" ]]; then
  EXISTING_SIGNING=$(printf '%s' "${EXISTING_JSON}" | jq -r --arg k "${SIGNING_KEY_KEY}" '.data.data[$k] // empty')
fi
if [[ -n "${EXISTING_SIGNING}" ]]; then
  SIGNING_SECRET="${EXISTING_SIGNING}"
  echo "  Tool-action signing secret: preserved existing value."
else
  SIGNING_SECRET=$(openssl rand -hex 32)
  echo "  Tool-action signing secret: generated."
fi

# Secrets reach jq via its environment (env.*), never argv.
PATCH_JSON=$(MK="${MASTER_KEY}" SK="${SIGNING_SECRET}" jq -n --arg k "${MASTER_KEY_KEY}" \
  --arg sn "${SIGNING_KEY_KEY}" '{ ($k): env.MK, ($sn): env.SK }')

for pair in \
  "database_url:${DATABASE_URL:-}" \
  "better_auth_secret:${BETTER_AUTH_SECRET:-}" \
  "session_secret:${SESSION_SECRET:-}" \
  "keycloak_client_id:${KEYCLOAK_CLIENT_ID:-}" \
  "keycloak_client_secret:${KEYCLOAK_CLIENT_SECRET:-}" \
  "minio_root_user:${MINIO_ROOT_USER:-}" \
  "minio_root_password:${MINIO_ROOT_PASSWORD:-}"
do
  key="${pair%%:*}"; val="${pair#*:}"
  if [[ -n "${val}" ]]; then
    PATCH_JSON=$(printf '%s' "${PATCH_JSON}" | jq --arg k "${key}" --arg v "${val}" '. + { ($k): $v }')
  fi
done

echo "Writing to Vault (kv patch = merge)..."
printf '%s' "${PATCH_JSON}" | vault kv patch -mount="${VAULT_MOUNT}" "${VAULT_PATH}" - >/dev/null

echo ""
echo "✓ Vault secrets patched (master key preserved or freshly generated)"
echo ""
echo "Verify (key names only, values hidden):"
echo "  vault kv get -mount=${VAULT_MOUNT} -format=json ${VAULT_PATH} | jq '.data.data | keys'"
echo ""
echo "Next: helm upgrade (see deploy/README.md), then confirm the pod env"
echo "PAPERCLIP_SECRETS_MASTER_KEY resolves and the app starts clean."
