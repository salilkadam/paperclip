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
for _ in $(seq 1 30); do root vault status >/dev/null 2>&1 && break; sleep 1; done
root vault status >/dev/null || { echo "dev Vault did not start" >&2; exit 1; }

cat > "$W/kubectl" <<EOF
#!/usr/bin/env bash
while [[ \$# -gt 0 && "\$1" != "--" ]]; do shift; done; shift
exec docker exec -i "$NAME" "\$@"
EOF
chmod +x "$W/kubectl"
export PATH="$W:$PATH"

fails=0
check() { if [[ "$2" == "$3" ]]; then echo "ok    $1"; else echo "FAIL  $1 (got: $2, want: $3)"; fails=$((fails+1)); fi; }

probe_with_policy() {  # probe_with_policy HCL -> exit code of the real probe
  printf '%s\n' "$1" | root vault policy write paperclip-under-test - >/dev/null
  local token
  token="$(root vault token create -policy=paperclip-under-test -ttl=10m -field=token)"
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

[[ $fails -eq 0 ]] && echo "ALL OK" || { echo "$fails check(s) failed"; exit 1; }
