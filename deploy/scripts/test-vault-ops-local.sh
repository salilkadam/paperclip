#!/usr/bin/env bash
# test-vault-ops-local.sh — exercise lib/vault-ops.sh, the bionic-org-ops policy
# (from setup-vault-ops-role.sh --print-policy) and probe-bionic-vault-token.sh
# against a throwaway Vault dev server in Docker (same version as production).
# A stub `kubectl` routes `kubectl exec … -- CMD` into the container and serves
# `kubectl create token` with a dummy JWT; the Kubernetes login itself is not
# exercised (it needs a real cluster), everything after it is.
#
# Planted defects must be caught: an over-broad policy fails the probe, a denied
# write inside a snippet fails the call. Exit 0 only if every case holds.
# Requires: docker. Usage: deploy/scripts/test-vault-ops-local.sh [vault-image]
set -euo pipefail
IMAGE="${1:-hashicorp/vault:1.21.2}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="vault-ops-test-$$"
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
case "\$*" in
  *"create token"*) echo "dummy.jwt.value"; exit 0 ;;
esac
while [[ \$# -gt 0 && "\$1" != "--" ]]; do shift; done; shift
exec docker exec -i "$NAME" "\$@"
EOF
chmod +x "$W/kubectl"
export PATH="$W:$PATH"

root sh -c 'vault kv put secret/t6-apps/mcp/config other=keep gworkspace_tenants_json=old >/dev/null
  vault kv put secret/t6-apps/bionic-org/sandbox brev_ssh_private_key=k >/dev/null
  vault kv put secret/t6-apps/ghost/config a=1 >/dev/null
  vault kv put secret/t6-apps/bionic-org/config paperclip_secrets_master_key=x >/dev/null'
"$HERE/setup-vault-ops-role.sh" --print-policy | root vault policy write bionic-org-ops - >/dev/null
OPS="$(root vault token create -policy=bionic-org-ops -ttl=15m -field=token)"

fails=0
check() { if [[ "$2" == "$3" ]]; then echo "ok    $1"; else echo "FAIL  $1 (got: $2, want: $3)"; fails=$((fails+1)); fi; }

# Run the real probe with login replaced by the pre-made ops token.
run_probe() {
  ( source "$HERE/lib/vault-ops.sh"
    vault_ops_login() { VAULT_OPS_TOKEN="$OPS"; }
    vault_ops_logout() { :; }
    eval "$(sed -n '/^source "\$HERE\/lib\/vault-ops.sh"/,$p' "$HERE/probe-bionic-vault-token.sh" | tail -n +2)" ) >"$W/probe.out" 2>&1
}
set +e; run_probe; rc=$?; set -e
check "probe passes with the real policy" "$rc" 0
[[ $rc -eq 0 ]] || cat "$W/probe.out"

with_ops() { ( source "$HERE/lib/vault-ops.sh"; VAULT_OPS_TOKEN="$OPS"; "$@" ); }

set +e
out="$(with_ops vault_ops_sh 'vault kv put secret/t6-apps/bionic-org/config x=1 >/dev/null 2>&1; echo UNREACHABLE')"; rc=$?
set -e
check "denied write fails the snippet (set -e)" "$([[ $rc -ne 0 && "$out" != *UNREACHABLE* ]] && echo yes || echo no)" yes

printf 'new-json' | docker exec -i "$NAME" sh -c 'cat > /tmp/nt.txt'
with_ops vault_ops_sh 'vault kv patch secret/t6-apps/mcp/config gworkspace_tenants_json=@/tmp/nt.txt >/dev/null'
check "kv patch @file sets the field" "$(root vault kv get -field=gworkspace_tenants_json secret/t6-apps/mcp/config)" new-json
check "kv patch @file keeps other fields" "$(root vault kv get -field=other secret/t6-apps/mcp/config)" keep

check "vault_ops_get returns the value" "$(with_ops vault_ops_get t6-apps/bionic-org/sandbox brev_ssh_private_key)" k
set +e; with_ops vault_ops_get t6-apps/bionic-org/config paperclip_secrets_master_key >/dev/null 2>&1; rc=$?; set -e
check "vault_ops_get of the master-key entry is denied" "$([[ $rc -ne 0 ]] && echo denied || echo allowed)" denied

# Planted defect: an over-broad policy must make the probe fail.
printf 'path "secret/data/t6-apps/*" { capabilities = ["read","update","patch"] }\n' | root vault policy write bionic-org-ops - >/dev/null
set +e; run_probe; rc=$?; set -e
check "probe FAILS on a planted over-broad policy" "$([[ $rc -ne 0 ]] && echo failed || echo passed)" failed
"$HERE/setup-vault-ops-role.sh" --print-policy | root vault policy write bionic-org-ops - >/dev/null

with_ops vault_ops_logout
set +e; root sh -c "VAULT_TOKEN=$OPS vault token lookup" >/dev/null 2>&1; rc=$?; set -e
check "vault_ops_logout revokes the token" "$([[ $rc -ne 0 ]] && echo revoked || echo live)" revoked

# Lint: POSIX errexit ignores commands inside && / || lists, so a write written
# as `vault kv put ... && echo ok` could fail silently. None may exist.
bad="$(grep -nE 'vault (kv (put|patch)|policy write|write)[^|]*&&' "$HERE"/*.sh "$HERE"/lib/*.sh | grep -v '^[^:]*:[0-9]*:[[:space:]]*#' || true)"
check "no Vault write inside an && list" "${bad:-none}" none

echo "---"; [[ $fails -eq 0 ]] && echo "all checks passed" || { echo "$fails check(s) failed"; exit 1; }
