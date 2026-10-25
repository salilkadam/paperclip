#!/usr/bin/env bash
# test-vault-paperclip-provider-local.sh — run probe-paperclip-vault-provider.sh
# against the policy from setup-vault-paperclip-provider.sh --print-policy on a
# throwaway Vault dev server in Docker (production version). A stub `kubectl`
# routes `kubectl exec … -- CMD` into the container; the Kubernetes login is
# replaced by a token carrying only the policy (it needs a real cluster).
#
# Planted defects must be caught: an over-broad policy and a policy missing
# metadata `create` both fail the probe. Exit 0 only if every case holds.
# Requires: docker (published ports not needed). Usage: $0 [vault-image]
set -euo pipefail
IMAGE="${1:-hashicorp/vault:1.21.2}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="vault-paperclip-provider-test-$$"
W="$(mktemp -d)"
command -v docker >/dev/null || { echo "docker is required" >&2; exit 69; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$W"; }
trap cleanup EXIT

docker run -d --name "$NAME" -e VAULT_DEV_ROOT_TOKEN_ID=devroot "$IMAGE" >/dev/null
root() { docker exec -i -e VAULT_TOKEN=devroot -e VAULT_ADDR=http://127.0.0.1:8200 "$NAME" "$@"; }
for _ in $(seq 1 90); do root vault status >/dev/null 2>&1 && break; sleep 1; done
root vault status >/dev/null 2>&1 || { echo "dev Vault did not start; container log:" >&2; docker logs "$NAME" 2>&1 | tail -30 >&2; exit 1; }

cat > "$W/kubectl" <<EOF
#!/usr/bin/env bash
case "\$*" in *"get serviceaccount"*) exit 0 ;; esac
while [[ \$# -gt 0 && "\$1" != "--" ]]; do shift; done; shift
exec docker exec -i "$NAME" "\$@"
EOF
chmod +x "$W/kubectl"
export PATH="$W:$PATH"

fails=0
check() { if [[ "$2" == "$3" ]]; then echo "ok    $1"; else echo "FAIL  $1 (got: $2, want: $3)"; fails=$((fails+1)); fi; }

probe_with_policy() {  # probe_with_policy HCL -> exit code of the real probe
  printf '%s\n' "$1" | root vault policy write paperclip-secrets - >/dev/null
  local token
  token="$(root vault token create -policy=paperclip-secrets -ttl=10m -field=token)"
  ( source "$HERE/lib/vault-ops.sh"
    vault_ops_login() { VAULT_OPS_TOKEN="$token"; }
    vault_ops_logout() { :; }
    eval "$(sed -n '/^source "\$HERE\/lib\/vault-ops.sh"/,$p' "$HERE/probe-paperclip-vault-provider.sh" | tail -n +2)" ) >"$W/probe.out" 2>&1
}

POLICY="$("$HERE/setup-vault-paperclip-provider.sh" --print-policy)"
set +e; probe_with_policy "$POLICY"; rc=$?; set -e
check "probe passes with the real policy" "$rc" 0
[[ $rc -eq 0 ]] || cat "$W/probe.out"

set +e; probe_with_policy "$POLICY
path \"secret/data/t6-apps/*\" { capabilities = [\"read\"] }"; rc=$?; set -e
check "probe fails on an over-broad policy (planted)" "$([[ $rc -ne 0 ]] && echo failed || echo passed)" failed
grep -q "FAIL  secret/data/t6-apps/bionic-org/config" "$W/probe.out" && echo "ok    ...and names the master-key path" || { echo "FAIL  master-key path not reported"; fails=$((fails+1)); }

NO_META_CREATE="$(printf '%s' "$POLICY" | awk 'BEGIN{n=0} /secret\/metadata\//{m=1} m && /capabilities/ {sub(/"create", /,""); m=0} {print}')"
set +e; probe_with_policy "$NO_META_CREATE"; rc=$?; set -e
check "probe fails without metadata create (planted)" "$([[ $rc -ne 0 ]] && echo failed || echo passed)" failed

# The setup script itself, against a dev Vault with Kubernetes auth: a role
# that already exists with fields the script must not keep is corrected, and
# the read-back assertions pass. A copy of the script missing one explicit
# parameter must fail its own read-back (planted).
root vault auth enable kubernetes >/dev/null
root vault write auth/kubernetes/role/bionic-org bound_service_account_names=x bound_service_account_namespaces=y audience=x \
  token_no_default_policy=true token_period=2h token_bound_cidrs=10.0.0.0/8 token_explicit_max_ttl=5h \
  alias_name_source=serviceaccount_name >/dev/null
printf 'devroot' > "$W/admin"; chmod 600 "$W/admin"
set +e; VAULT_TOKEN_FILE="$W/admin" "$HERE/setup-vault-paperclip-provider.sh" >"$W/setup.out" 2>&1; rc=$?; set -e
check "setup corrects a drifted role and its read-back passes" "$rc" 0
[[ $rc -eq 0 ]] || cat "$W/setup.out"
check "role no longer drops the default policy" "$(root vault read -field=token_no_default_policy auth/kubernetes/role/bionic-org)" false
root vault write auth/kubernetes/role/bionic-org token_no_default_policy=true >/dev/null
sed 's/ token_no_default_policy=false//' "$HERE/setup-vault-paperclip-provider.sh" > "$W/setup-planted.sh"; chmod +x "$W/setup-planted.sh"
set +e; VAULT_TOKEN_FILE="$W/admin" "$W/setup-planted.sh" >"$W/setup-planted.out" 2>&1; rc=$?; set -e
check "planted setup without the explicit parameter fails its read-back" "$([[ $rc -ne 0 ]] && echo failed || echo passed)" failed
grep -q "FAIL  role token_no_default_policy" "$W/setup-planted.out" && echo "ok    ...and names the field" || { echo "FAIL  field not named"; cat "$W/setup-planted.out"; fails=$((fails+1)); }

[[ $fails -eq 0 ]] && echo "ALL OK" || { echo "$fails check(s) failed"; exit 1; }
