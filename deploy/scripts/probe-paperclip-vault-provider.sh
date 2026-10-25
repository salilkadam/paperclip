#!/usr/bin/env bash
# Probe the Paperclip server's Vault identity (role bionic-org, policy
# paperclip-secrets; see setup-vault-paperclip-provider.sh). Logs in exactly as
# the server does — a short-lived audience-"vault" token for bionicorg/
# bionic-org-sa — then asks Vault for this token's capabilities on every path
# the provider needs and on paths it must NOT reach, and revokes the token.
# Reads and writes no secret. Exit 0 only if every expectation holds.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export VAULT_OPS_SA_NAMESPACE=bionicorg VAULT_OPS_SA=bionic-org-sa VAULT_OPS_ROLE=bionic-org
# shellcheck source=lib/vault-ops.sh
source "$HERE/lib/vault-ops.sh"
trap vault_ops_logout EXIT
vault_ops_login

vault_ops_sh '
fail=0
expect_cap() {  # expect_cap PATH EXACT_CAPS (capabilities-self: authoritative, mutates nothing)
  got=$(vault token capabilities "$1" | tr -d " ") || got="ERROR"
  if [ "$got" = "$2" ]; then echo "ok    $1: $got"; else echo "FAIL  $1: $got (expected $2)"; fail=1; fi
}
P=t6-apps/bionic-org/paperclip
vault token lookup -format=json | grep -E "\"policies\"|\"ttl\"" -A2 | tr -s " \n" " "; echo
expect_cap secret/data/$P/companies/probe/company/x      create,read,update
expect_cap secret/metadata/$P/companies/probe/company/x  create,read,update
expect_cap secret/delete/$P/companies/probe/company/x    update
expect_cap secret/destroy/$P/companies/probe/company/x   deny
expect_cap secret/undelete/$P/companies/probe/company/x  deny
expect_cap secret/data/t6-apps/bionic-org/sandbox        read
expect_cap secret/data/t6-apps/mcp/config                read
expect_cap secret/data/t6-apps/bionic-org/config         deny
expect_cap secret/metadata/t6-apps/bionic-org/config     deny
expect_cap secret/data/t6-apps/bionic-org/logins         deny
expect_cap secret/data/t6-apps/ghost/config              deny
expect_cap secret/data/t6-apps/vault/admin_token         deny
expect_cap secret/data/shared/api-keys                   deny
expect_cap secret/data/t6-apps/bionic-org/paperclip2/x   deny
expect_cap sys/policies/acl/paperclip-secrets            deny
expect_cap auth/kubernetes/role/bionic-org               deny
exit $fail
'
