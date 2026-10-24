
# Step 1 of tenant-client switch: fetch current mcp config data into a local
# 0600 file for transformation. Never prints values.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/vault-ops.sh
source "$HERE/lib/vault-ops.sh"
trap vault_ops_logout EXIT
vault_ops_login
vault_ops_sh '
vault kv get -format=json secret/t6-apps/mcp/config > /tmp/mcp-cfg.json
echo "data keys:"; grep -o "\"[a-z_]*\":" /tmp/mcp-cfg.json | tr -d "\":
" | sort -u | head -12
'
timeout 60 kubectl -n vault cp vault-0:/tmp/mcp-cfg.json /tmp/mcp-cfg.json
timeout 60 kubectl -n vault exec vault-0 -- rm -f /tmp/mcp-cfg.json   # no secret copy left in the Vault pod
chmod 600 /tmp/mcp-cfg.json
echo "saved locally: $(wc -c < /tmp/mcp-cfg.json) bytes"
