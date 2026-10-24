#!/usr/bin/env bash
# Probe the ops Vault identity (role/policy bionic-org-ops, see
# setup-vault-ops-role.sh). Logs in with a short-lived ServiceAccount token,
# checks every capability the ops scripts need AND that nothing broader is
# allowed (incl. the master-key config entry), then revokes the token. Reads no
# secret at all.
# Exit 0 only if every expectation holds.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/vault-ops.sh
source "$HERE/lib/vault-ops.sh"
trap vault_ops_logout EXIT
vault_ops_login

vault_ops_sh '
fail=0
# Every check asks Vault for the capabilities of this token (capabilities-self):
# authoritative, never mutates a secret, and cannot mistake "path missing" for
# "denied".
expect_cap() {  # expect_cap PATH EXACT_CAPS
  got=$(vault token capabilities "$1" | tr -d " ") || got="ERROR"
  if [ "$got" = "$2" ]; then echo "ok    $1: $got"; else echo "FAIL  $1: $got (expected $2)"; fail=1; fi
}
vault token lookup -format=json | grep -E "\"policies\"|\"ttl\"" -A2 | tr -s " \n" " "; echo
expect_cap secret/data/t6-apps/bionic-org/sandbox  read
expect_cap secret/data/t6-apps/mcp/config          patch,read,update
expect_cap secret/data/t6-apps/ghost/config        read
expect_cap secret/data/t6-apps/bionic-org/config   deny
expect_cap secret/data/t6-apps/bionic-org/logins   deny
expect_cap secret/data/t6-apps/vault/admin_token   deny
expect_cap secret/data/shared/api-keys             deny
expect_cap secret/metadata/t6-apps/mcp/config      deny
expect_cap secret/destroy/t6-apps/mcp/config       deny
expect_cap secret/data/t6-apps/probe-test          deny
expect_cap sys/policies/acl/probe                  deny
expect_cap auth/kubernetes/role/bionic-org-ops     deny
exit $fail
'
