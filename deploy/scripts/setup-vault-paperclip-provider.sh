#!/usr/bin/env bash
# setup-vault-paperclip-provider.sh — create/refresh the Vault policy and
# Kubernetes-auth role the Paperclip server uses for its HashiCorp Vault secret
# provider (server/src/secrets/vault-provider.ts, doc/SECRETS-VAULT-PROVIDER.md).
# Idempotent and additive: writes only policy `paperclip-secrets` and role
# `bionic-org` (auth/kubernetes). Touches no secret. A role write MERGES into an
# existing role, so every token parameter is set explicitly and both objects
# are read back and checked; any drift fails the script.
#
# The role binds the app's own ServiceAccount bionicorg/bionic-org-sa, and only
# tokens with audience "vault" (the chart projects one at
# /var/run/secrets/vault/token, separate from the API-server token).
#
# Needs a Vault token allowed to write sys/policies/acl and auth/kubernetes/role
# (an operator admin token), read from the file named by VAULT_TOKEN_FILE (mode
# 0600) or a hidden prompt. Never from /workspace/.env, never in argv.
#
# Usage:
#   VAULT_TOKEN_FILE=~/.vault-admin-token deploy/scripts/setup-vault-paperclip-provider.sh
#   deploy/scripts/setup-vault-paperclip-provider.sh --print-policy
# Verify afterwards: deploy/scripts/probe-paperclip-vault-provider.sh
set -euo pipefail

ROLE=bionic-org
POLICY=paperclip-secrets
SA_NAME=bionic-org-sa
SA_NAMESPACE=bionicorg
AUTH_MOUNT=kubernetes
VAULT_NS=vault
VAULT_POD=vault-0
PREFIX=t6-apps/bionic-org/paperclip

# Managed prefix: create/read/update data, create/read/update metadata (setting
# max_versions on a NEW entry is a metadata create; read+update alone is
# denied — proven by scripts/test-vault-provider-integration.sh), soft delete.
# No destroy, undelete, HTTP PATCH, list or metadata delete. (The token also
# carries Vault's `default` policy, which supplies renew-self/revoke-self.)
# External references (read-only): owner decision 7.4 — all of mcp/config.
# Deliberately NOT t6-apps/bionic-org/config (master key) or anything else.
POLICY_HCL="path \"secret/data/$PREFIX/*\" {
  capabilities = [\"create\", \"read\", \"update\"]
}
path \"secret/metadata/$PREFIX/*\" {
  capabilities = [\"create\", \"read\", \"update\"]
}
path \"secret/delete/$PREFIX/*\" {
  capabilities = [\"update\"]
}
path \"secret/data/t6-apps/bionic-org/sandbox\" {
  capabilities = [\"read\"]
}
path \"secret/data/t6-apps/mcp/config\" {
  capabilities = [\"read\"]
}"

if [[ "${1:-}" == "--print-policy" ]]; then printf '%s\n' "$POLICY_HCL"; exit 0; fi

command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 69; }
if [[ -n "${VAULT_TOKEN_FILE:-}" ]]; then
  [[ -r "$VAULT_TOKEN_FILE" ]] || { echo "VAULT_TOKEN_FILE is not readable" >&2; exit 1; }
  [[ "$(stat -c %a "$VAULT_TOKEN_FILE")" == 600 ]] || { echo "VAULT_TOKEN_FILE must be mode 0600" >&2; exit 1; }
  ADMIN_TOKEN="$(tr -d '\r\n' < "$VAULT_TOKEN_FILE")"
else
  read -r -s -p "Vault admin token: " ADMIN_TOKEN; echo
fi
[[ -n "$ADMIN_TOKEN" ]] || { echo "empty admin token" >&2; exit 1; }

timeout 30 kubectl -n "$SA_NAMESPACE" get serviceaccount "$SA_NAME" >/dev/null \
  || { echo "serviceaccount $SA_NAMESPACE/$SA_NAME not found (deploy the bionic-org chart first)" >&2; exit 1; }

# Token on line 1, policy HCL on the remaining lines; nothing secret in argv.
{ printf '%s\n' "$ADMIN_TOKEN"; printf '%s\n' "$POLICY_HCL"; } \
  | timeout 120 kubectl exec -i -n "$VAULT_NS" "$VAULT_POD" -- sh -c '
set -e
read -r VAULT_TOKEN; export VAULT_TOKEN VAULT_ADDR=http://127.0.0.1:8200
WANT_POLICY="$(cat)"
printf "%s\n" "$WANT_POLICY" | vault policy write "$1" - >/dev/null
echo "policy $1 written"
vault write "auth/$3/role/$2" \
  bound_service_account_names="$4" bound_service_account_namespaces="$5" \
  audience=vault alias_name_source=serviceaccount_uid bound_service_account_namespace_selector="" \
  token_policies="$1" token_no_default_policy=false token_ttl=1h token_max_ttl=24h \
  token_period=0 token_explicit_max_ttl=0 token_num_uses=0 token_bound_cidrs="" token_type=default >/dev/null
echo "role $2 written"
# Read back and check: the role write merges, so a pre-existing role could
# otherwise keep a field this script does not mean to allow.
fail=0
want() { got="$(vault read -field="$2" "auth/$3/role/$4")" || got="ERROR"
  if [ "$got" = "$1" ]; then echo "ok    role $2 = $got"; else echo "FAIL  role $2 = $got (expected $1)"; fail=1; fi; }
want "[$4]" bound_service_account_names "$3" "$2"
want "[$5]" bound_service_account_namespaces "$3" "$2"
want vault audience "$3" "$2"
want "[$1]" token_policies "$3" "$2"
want false token_no_default_policy "$3" "$2"
want 3600 token_ttl "$3" "$2"
want 86400 token_max_ttl "$3" "$2"
want 0 token_period "$3" "$2"
want 0 token_num_uses "$3" "$2"
want "[]" token_bound_cidrs "$3" "$2"
want 0 token_explicit_max_ttl "$3" "$2"
want default token_type "$3" "$2"
want serviceaccount_uid alias_name_source "$3" "$2"
want "" bound_service_account_namespace_selector "$3" "$2"
if [ "$(vault policy read "$1")" = "$WANT_POLICY" ]; then echo "ok    policy $1 matches"; else echo "FAIL  policy $1 differs from the script"; fail=1; fi
exit $fail
' _ "$POLICY" "$ROLE" "$AUTH_MOUNT" "$SA_NAME" "$SA_NAMESPACE"
unset ADMIN_TOKEN

echo "Verify: deploy/scripts/probe-paperclip-vault-provider.sh"
