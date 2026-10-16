#!/usr/bin/env bash
# Resolve the GPU-stack API key (X-API-Key for https://mcp.baisoln.com).
#
# Inside Paperclip the key is platform-provided: Vault `shared/api-keys`
# (`mcp_api_key`) -> External Secrets -> pod env `MCP_API_KEY`, inherited by
# every agent process. Agents never fetch secrets from Vault or Kubernetes
# themselves, so there is deliberately no kubectl/vault fallback here.
#
# Prints ONLY the key to stdout (diagnostics go to stderr), so it is safe as:
#   KEY=$(./get_key.sh) || exit 1
set -uo pipefail

for name in MCP_API_KEY mcp_api_key; do
  value="${!name:-}"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    exit 0
  fi
done

echo "ERROR: MCP_API_KEY is not set in this runtime." >&2
echo "It is injected by the platform (Vault shared/api-keys:mcp_api_key via External Secrets)." >&2
echo "Do not try to fetch it yourself; report the missing env var to the operator/board." >&2
exit 1
