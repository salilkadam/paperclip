#!/usr/bin/env bash
# Probe the ops Vault identity (role/policy bionic-org-ops, see
# setup-vault-ops-role.sh). Logs in with a short-lived ServiceAccount token,
# checks every capability the ops scripts need AND that nothing broader is
# allowed, then revokes the token. Never prints a secret value.
# Exit 0 only if every expectation holds.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/vault-ops.sh
source "$HERE/lib/vault-ops.sh"
vault_ops_login
trap vault_ops_logout EXIT

vault_ops_sh '
fail=0
expect() {  # expect allow|deny LABEL COMMAND...
  want=$1; label=$2; shift 2
  if "$@" >/dev/null 2>&1; then got=allow; else got=deny; fi
  if [ "$got" = "$want" ]; then echo "ok    $label: $got"; else echo "FAIL  $label: $got (expected $want)"; fail=1; fi
}
vault token lookup -format=json | grep -E "\"policies\"|\"ttl\"" -A2 | tr -s " \n" " "; echo
expect allow "read  bionic-org/config"  vault kv get secret/t6-apps/bionic-org/config
expect allow "read  bionic-org/sandbox" vault kv get secret/t6-apps/bionic-org/sandbox
expect allow "read  mcp/config"         vault kv get secret/t6-apps/mcp/config
expect allow "read  ghost/config"       vault kv get secret/t6-apps/ghost/config
expect deny  "read  bionic-org/logins"  vault kv get secret/t6-apps/bionic-org/logins
expect deny  "read  vault/admin_token"  vault kv get secret/t6-apps/vault/admin_token
expect deny  "read  shared/api-keys"    vault kv get secret/shared/api-keys
# Write checks ask Vault for the capabilities instead of attempting the write,
# so a wrongly broad policy is reported without mutating real secrets.
cap() { vault token capabilities "$1" | tr -d " "; }
expect_cap() {  # expect_cap PATH EXACT_CAPS
  got=$(cap "$1"); if [ "$got" = "$2" ]; then echo "ok    caps $1: $got"; else echo "FAIL  caps $1: $got (expected $2)"; fail=1; fi
}
expect_cap secret/data/t6-apps/bionic-org/config  read
expect_cap secret/data/t6-apps/bionic-org/sandbox read
expect_cap secret/data/t6-apps/mcp/config         patch,read,update
expect_cap secret/data/t6-apps/ghost/config       read
expect_cap secret/destroy/t6-apps/mcp/config      deny
expect_cap secret/data/t6-apps/probe-test         deny
expect_cap sys/policies/acl/probe                 deny
exit $fail
'
