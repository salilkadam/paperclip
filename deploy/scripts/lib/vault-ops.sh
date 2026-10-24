# deploy/scripts/lib/vault-ops.sh — short-lived Vault access for ops scripts.
# Source it; do not execute it.
#
# No static Vault token is read from anywhere (not /workspace/.env, not a pod
# env var, not a K8s secret). The operator's kubeconfig — which every script
# here already needs — is the only bootstrap credential:
#
#   1. `kubectl create token` mints a 10-minute JWT (audience "vault") for the
#      identity-only ServiceAccount vault/bionic-org-ops. It lives in the vault
#      namespace on purpose: no non-admin workload there may create pods or
#      ServiceAccount tokens (in bionicorg, the SRE harness can).
#   2. That JWT is exchanged at Vault's Kubernetes auth method (role
#      bionic-org-ops, policy bionic-org-ops, TTL 15m) for a Vault token.
#   3. The Vault token lives in this shell's memory only and reaches vault-0 on
#      stdin, never argv or disk. vault_ops_logout revokes it.
#
# The SA, role and policy are created by deploy/scripts/setup-vault-ops-role.sh.
#
#   source "$(dirname "$0")/lib/vault-ops.sh"
#   vault_ops_login
#   trap vault_ops_logout EXIT          # or call it from your own EXIT trap
#   key="$(vault_ops_get t6-apps/mcp/config some_field)"
#   vault_ops_sh 'vault kv get -format=json secret/t6-apps/mcp/config' > out.json

VAULT_OPS_SA_NAMESPACE="${VAULT_OPS_SA_NAMESPACE:-vault}"
VAULT_OPS_SA="${VAULT_OPS_SA:-bionic-org-ops}"
VAULT_OPS_ROLE="${VAULT_OPS_ROLE:-bionic-org-ops}"
VAULT_OPS_AUTH_MOUNT="${VAULT_OPS_AUTH_MOUNT:-kubernetes}"
VAULT_OPS_POD_NAMESPACE="${VAULT_OPS_POD_NAMESPACE:-vault}"
VAULT_OPS_POD="${VAULT_OPS_POD:-vault-0}"
VAULT_OPS_TIMEOUT="${VAULT_OPS_TIMEOUT:-60}"
VAULT_OPS_TOKEN=""

vault_ops_die() { echo "vault-ops: $*" >&2; exit 1; }

# vault_ops_login — sets VAULT_OPS_TOKEN or exits non-zero with the reason.
vault_ops_login() {
  [[ -n "$VAULT_OPS_TOKEN" ]] && return 0
  command -v kubectl >/dev/null || vault_ops_die "kubectl is required"
  local jwt
  jwt="$(timeout 30 kubectl -n "$VAULT_OPS_SA_NAMESPACE" create token "$VAULT_OPS_SA" --duration=10m --audience=vault)" \
    || vault_ops_die "cannot mint a token for serviceaccount $VAULT_OPS_SA_NAMESPACE/$VAULT_OPS_SA (run deploy/scripts/setup-vault-ops-role.sh; kubeconfig allowed to create tokens?)"
  [[ -n "$jwt" ]] || vault_ops_die "kubectl create token returned an empty token"
  # jwt=- makes the vault CLI read the JWT from stdin: it never reaches argv.
  VAULT_OPS_TOKEN="$(printf '%s' "$jwt" | timeout "$VAULT_OPS_TIMEOUT" kubectl exec -i -n "$VAULT_OPS_POD_NAMESPACE" "$VAULT_OPS_POD" -- \
    sh -c 'VAULT_ADDR=http://127.0.0.1:8200 vault write -field=token "auth/$1/login" role="$2" jwt=-' _ \
    "$VAULT_OPS_AUTH_MOUNT" "$VAULT_OPS_ROLE")" \
    || vault_ops_die "Vault login failed for role $VAULT_OPS_ROLE (run deploy/scripts/setup-vault-ops-role.sh; is Vault unsealed?)"
  [[ -n "$VAULT_OPS_TOKEN" ]] || vault_ops_die "Vault login for role $VAULT_OPS_ROLE returned an empty token"
}

# vault_ops_sh SNIPPET [ARGS...] — run a shell snippet inside the Vault pod with
# VAULT_TOKEN/VAULT_ADDR exported; ARGS are $1.. inside the snippet. The snippet
# runs under `set -e`: the first failing command fails the call, so a denied
# write can never be followed by "success". Use `|| true` explicitly for
# commands allowed to fail. The snippet cannot read further stdin (the token is
# the first line).
vault_ops_sh() {
  [[ -n "$VAULT_OPS_TOKEN" ]] || vault_ops_die "vault_ops_sh called before vault_ops_login"
  local snippet="$1"; shift
  printf '%s\n' "$VAULT_OPS_TOKEN" | timeout "$VAULT_OPS_TIMEOUT" kubectl exec -i -n "$VAULT_OPS_POD_NAMESPACE" "$VAULT_OPS_POD" -- \
    sh -c "set -e; read -r VAULT_TOKEN; export VAULT_TOKEN VAULT_ADDR=http://127.0.0.1:8200; $snippet" _ "$@"
}

# vault_ops_get PATH FIELD — value of secret/PATH:FIELD on stdout. Absent,
# unreadable or empty is fatal: an empty string is never returned as success.
vault_ops_get() {
  local v
  v="$(vault_ops_sh 'vault kv get -field="$2" "secret/$1"' "$1" "$2")" \
    || vault_ops_die "cannot read Vault secret/$1:$2"
  [[ -n "$v" ]] || vault_ops_die "Vault secret/$1:$2 is empty"
  printf '%s' "$v"
}

# vault_ops_logout — revoke the token. A failure is reported, not hidden: the
# token still expires on its own after its 15-minute TTL.
vault_ops_logout() {
  [[ -n "$VAULT_OPS_TOKEN" ]] || return 0
  vault_ops_sh 'vault token revoke -self >/dev/null' \
    || echo "vault-ops: WARNING token revoke failed; it expires within its 15m TTL" >&2
  VAULT_OPS_TOKEN=""
}
