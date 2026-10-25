#!/usr/bin/env bash
# setup-vault-ops-role.sh — create/refresh the Vault policy + Kubernetes-auth
# role that deploy/scripts/lib/vault-ops.sh logs in with. Idempotent and
# additive: it writes only policy `bionic-org-ops` and role `bionic-org-ops`.
#
# It also creates the identity-only ServiceAccount vault/bionic-org-ops
# (automount off, no RBAC). It sits in the vault namespace because no non-admin
# workload there may create pods or ServiceAccount tokens; in bionicorg the SRE
# harness may, and could otherwise mint this identity.
#
# Needs a Vault token allowed to write sys/policies/acl and
# auth/kubernetes/role — an operator admin token. It is read from the file named
# by VAULT_TOKEN_FILE (must be mode 0600) or, if unset, from a hidden prompt.
# It is never read from /workspace/.env and never placed in argv.
#
# Usage:
#   VAULT_TOKEN_FILE=~/.vault-admin-token deploy/scripts/setup-vault-ops-role.sh
#   deploy/scripts/setup-vault-ops-role.sh --print-policy   # show policy, change nothing
set -euo pipefail

ROLE=bionic-org-ops
POLICY=bionic-org-ops
SA_NAME=bionic-org-ops
SA_NAMESPACE=vault
AUTH_MOUNT=kubernetes
VAULT_NS=vault
VAULT_POD=vault-0

# Exactly what the ops scripts touch:
#   bionic-org/sandbox  read               (operator reads; the server reads it via its own role)
#   mcp/config          read/update/patch  switch-tenant-client-*, setup-ghost-connections (copy mode)
#   ghost/config        read               setup-ghost-plugin
# Deliberately NOT bionic-org/config: it holds the secrets master key and no
# ops script needs it.
POLICY_HCL='path "secret/data/t6-apps/bionic-org/sandbox" {
  capabilities = ["read"]
}
path "secret/data/t6-apps/mcp/config" {
  capabilities = ["read", "update", "patch"]
}
path "secret/data/t6-apps/ghost/config" {
  capabilities = ["read"]
}'

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

timeout 60 kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: $SA_NAME
  namespace: $SA_NAMESPACE
  labels:
    app.kubernetes.io/part-of: bionic-org
    app.kubernetes.io/component: vault-ops-identity
automountServiceAccountToken: false
EOF
echo "serviceaccount $SA_NAMESPACE/$SA_NAME applied"

# Token on line 1, policy HCL on the remaining lines; nothing secret in argv.
{ printf '%s\n' "$ADMIN_TOKEN"; printf '%s\n' "$POLICY_HCL"; } \
  | timeout 120 kubectl exec -i -n "$VAULT_NS" "$VAULT_POD" -- sh -c '
set -e
read -r VAULT_TOKEN; export VAULT_TOKEN VAULT_ADDR=http://127.0.0.1:8200
vault policy write "$1" - >/dev/null
echo "policy $1 written"
vault write "auth/$3/role/$2" \
  bound_service_account_names="$4" bound_service_account_namespaces="$5" \
  audience=vault token_policies="$1" token_ttl=15m token_max_ttl=1h >/dev/null
echo "role $2 written (sa $5/$4, audience vault, ttl 15m, max 1h)"
' _ "$POLICY" "$ROLE" "$AUTH_MOUNT" "$SA_NAME" "$SA_NAMESPACE"
unset ADMIN_TOKEN

echo "Verify: deploy/scripts/probe-bionic-vault-token.sh"
