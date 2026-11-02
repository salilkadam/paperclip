#!/usr/bin/env bash
# setup-dp-agreement-pipeline.sh — wire the Design Partner agreement pipeline for Reliora
# after Loc-AgentMail 0.2.0 is deployed (PR #80).
#
#   1. Drive: under AI Team > COO > design-partner-contracts, ensure folders
#      `sent`, `received`, `executed` exist (created through the Google Workspace
#      MCP server, account salil-bionicaisolutions, tenant base).
#   2. Loc-AgentMail config for Reliora: `reliora-info` may attach the
#      reliora-dp-agreement-v1.0 template; `drive` lists only those three folders.
#   3. Gateway policies for the COO (priority 9, ahead of the job-function blocks at 11):
#        - send WITH an attachment            -> require_approval (board approves the exact email)
#        - create_drive_file to dp-received   -> allow (filing a reply for review)
#        - create_drive_file anywhere else    -> require_approval (filing to executed is the board's review)
#      Plain `send` stays blocked for C-level agents by the job-function rule.
#   4. Verify: config read back, policies listed, folders listed.
#
# Usage:
#   PAPERCLIP_BOARD_KEY_FILE=/path/to/board-key bash deploy/scripts/setup-dp-agreement-pipeline.sh [--dry-run]
# The Workspace MCP server only accepts calls through Kong with the gateway key
# (Vault secret/shared/api-keys, field mcp_api_key). The script reads it with
# lib/vault-ops.sh, or from MCP_API_KEY_FILE (a 0600 file) if you set that.
# Needs: kubectl (cluster access), curl, jq. Prints no secret values.
set -euo pipefail

DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1
API="${PAPERCLIP_API:-https://org.baisoln.com/api}"
COMPANY="62d63984-df6c-49be-981c-1273f68a451c"   # Reliora
COO="70499d70-c8de-4a11-b75f-70596e18e7e2"
PLUGIN="paperclip.loc-agentmail"
TEMPLATE="reliora-dp-agreement-v1.0"
TENANT="base"; ACCOUNT="salil-bionicaisolutions"
AI_TEAM_ROOT="1MmJAx3Rkag90KSSlFISiVvkuWwvO38dK"
DRIVE_URL="https://mcp.baisoln.com/gworkspace/mcp"   # through Kong, which checks X-API-Key
# The gateway key the Loc-Google Workspace connection (78ad5e0e) already uses, as a Paperclip secret ref.
DRIVE_KEY_SECRET_ID="622bf7b5-10d1-42c9-958b-3b48ca973398"

die() { echo "FAIL: $*" >&2; exit 1; }
for bin in kubectl curl jq; do command -v "$bin" >/dev/null || die "$bin is not installed"; done
[[ -n "${PAPERCLIP_BOARD_KEY_FILE:-}" && -s "$PAPERCLIP_BOARD_KEY_FILE" ]] || die "set PAPERCLIP_BOARD_KEY_FILE to a file holding a board API key"
KEY="$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")"

api() { # METHOD PATH [JSON] -> body; fails on non-2xx
  local out code; out="$(mktemp)"
  code="$(curl -sS -m 60 -o "$out" -w '%{http_code}' -X "$1" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' ${3:+--data "$3"} "$API$2")" || { rm -f "$out"; die "$1 $2: network error"; }
  [[ "${code:0:1}" == 2 ]] || { echo "  body: $(head -c 600 "$out")" >&2; rm -f "$out"; die "$1 $2 -> HTTP $code"; }
  cat "$out"; rm -f "$out"
}

# ---- Drive via the Workspace MCP server, through Kong -----------------------------------
HDR="$(mktemp)"; chmod 600 "$HDR"
trap 'rm -f "$HDR"; type vault_ops_logout >/dev/null 2>&1 && vault_ops_logout || true' EXIT
if [[ -n "${MCP_API_KEY_FILE:-}" ]]; then
  [[ -s "$MCP_API_KEY_FILE" ]] || die "MCP_API_KEY_FILE is empty or missing"
  printf 'x-api-key: %s\n' "$(tr -d '\r\n' < "$MCP_API_KEY_FILE")" > "$HDR"
else
  # shellcheck source=lib/vault-ops.sh
  source "$(dirname "$0")/lib/vault-ops.sh"
  vault_ops_login
  printf 'x-api-key: %s\n' "$(vault_ops_get shared/api-keys mcp_api_key)" > "$HDR" \
    || die "could not read shared/api-keys mcp_api_key with the ops role; set MCP_API_KEY_FILE instead"
fi
grep -q '^x-api-key: .\+' "$HDR" || die "the gateway key is empty"
mcp() { # TOOL ARGS_JSON -> tool payload JSON; fails on success:false
  local body payload code
  body="$(curl -sS -m 60 -w '\n%{http_code}' -X POST "$DRIVE_URL" -H @"$HDR" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    --data "$(jq -nc --arg t "$1" --argjson a "$2" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$t,arguments:$a}}')")" || die "MCP $1: network error"
  code="${body##*$'\n'}"; body="${body%$'\n'*}"
  [[ "$code" == 200 ]] || die "MCP $1 -> HTTP $code (gateway key rejected?): ${body:0:200}"
  body="$(printf '%s' "$body" | sed -n 's/^data: //p;/^{/p' | tail -1)"
  payload="$(jq -c '.result.structuredContent // (.result.content[0].text | fromjson)' <<<"$body" 2>/dev/null)" || die "MCP $1: unreadable reply: ${body:0:300}"
  [[ "$(jq -r '.success' <<<"$payload")" == "true" ]] || die "MCP $1 failed: $(jq -r '.error // .' <<<"$payload" | head -c 300)"
  printf '%s' "$payload"
}
find_folder() { # PARENT NAME -> id or empty
  mcp gw_list_files "$(jq -nc --arg t "$TENANT" --arg a "$ACCOUNT" --arg q "'$1' in parents and name = '$2' and mimeType = 'application/vnd.google-apps.folder' and trashed = false" \
    '{tenant_id:$t,account:$a,query:$q,max_results:5}')" | jq -r '[.data.files // .data // [] | .[]?.id] | first // empty'
}
ensure_folder() { # PARENT NAME -> id
  local id; id="$(find_folder "$1" "$2")"
  if [[ -z "$id" ]]; then
    if (( DRY )); then echo "DRYRUN:$2"; return; fi
    id="$(mcp gw_create_folder "$(jq -nc --arg t "$TENANT" --arg a "$ACCOUNT" --arg n "$2" --arg p "$1" '{tenant_id:$t,account:$a,name:$n,folder_id:$p}')" | jq -r '.data.id')"
    [[ -n "$id" && "$id" != null ]] || die "creating folder $2 returned no id"
    echo "  created folder $2 ($id)" >&2
  fi
  echo "$id"
}

echo "== 1. Drive folders"
COO_DIR="$(find_folder "$AI_TEAM_ROOT" COO)"; [[ -n "$COO_DIR" ]] || die "AI Team > COO folder not found"
DPC="$(ensure_folder "$COO_DIR" design-partner-contracts)"
SENT="$(ensure_folder "$DPC" sent)"; RECV="$(ensure_folder "$DPC" received)"; EXEC="$(ensure_folder "$DPC" executed)"
echo "  design-partner-contracts=$DPC sent=$SENT received=$RECV executed=$EXEC"

# ---- Plugin config ----------------------------------------------------------------------
echo "== 2. Loc-AgentMail config for Reliora"
CURRENT="$(api GET "/plugins/$PLUGIN/config?companyId=$COMPANY")"
CFG="$(jq -c '.configJson // .config // .' <<<"$CURRENT")"
jq -e '.accounts | map(.key) | index("reliora-info")' <<<"$CFG" >/dev/null || die "reliora-info is not a configured mailbox"
NEW="$(jq -c --arg t "$TEMPLATE" --arg url "$DRIVE_URL" --arg ten "$TENANT" --arg acc "$ACCOUNT" --arg key "$DRIVE_KEY_SECRET_ID" \
  --arg s "$SENT" --arg r "$RECV" --arg e "$EXEC" '
  .accounts |= map(if .key == "reliora-info" then .documentTemplates = ((.documentTemplates // []) + [$t] | unique) else . end)
  | .drive = {mcpUrl: $url, tenantId: $ten, account: $acc, apiKey: {type: "secret_ref", secretId: $key, version: "latest"},
              folders: {"dp-sent": $s, "dp-received": $r, "dp-executed": $e}}' <<<"$CFG")"
echo "  change: $(diff <(jq -S 'del(.accounts[].password) | {accounts: [.accounts[] | {key, documentTemplates}], drive}' <<<"$CFG") <(jq -S 'del(.accounts[].password) | {accounts: [.accounts[] | {key, documentTemplates}], drive}' <<<"$NEW") | grep '^[<>]' | tr '\n' ' ')"
if (( ! DRY )); then
  api POST "/plugins/$PLUGIN/config" "$(jq -nc --arg c "$COMPANY" --argjson j "$NEW" '{companyId:$c, configJson:$j}')" >/dev/null
  api GET "/plugins/$PLUGIN/config?companyId=$COMPANY" | jq -e --arg e "$EXEC" '(.configJson // .config // .) | .drive.folders["dp-executed"] == $e' >/dev/null || die "config did not read back"
  echo "  config saved and read back"
fi

# ---- Policies ----------------------------------------------------------------------------
echo "== 3. Gateway policies for the COO"
EXISTING="$(api GET "/companies/$COMPANY/tools/policies" | jq -c '.policies // .items // .')"
ensure_policy() { # JSON
  local name; name="$(jq -r .name <<<"$1")"
  if jq -e --arg n "$name" 'map(select(.name == $n)) | length > 0' <<<"$EXISTING" >/dev/null; then echo "  exists: $name"; return; fi
  if (( DRY )); then echo "  would create: $name"; return; fi
  api POST "/companies/$COMPANY/tools/policies" "$1" | jq -r '"  created: \(.name) (\(.id))"'
}
ensure_policy "$(jq -nc '{name:"dp-pipeline: every agreement send needs board approval", description:"Any agent sending an email with a rendered document attached needs the board to approve the exact email. Applies company-wide, not only to the COO. Plain sends by C-level agents stay blocked by the job-function rule.", policyType:"require_approval", priority:9, enabled:true, selectors:{toolNames:["paperclip.loc-agentmail:send"]}, conditions:{arguments:{fieldExists:["attachments.0"]}}}')"
ensure_policy "$(jq -nc --arg a "$COO" '{name:"dp-pipeline: COO files signed replies for review", description:"Filing a received attachment to the dp-received folder needs no approval.", policyType:"allow", priority:9, enabled:true, selectors:{agentIds:[$a], toolNames:["paperclip.loc-agentmail:create_drive_file"]}, conditions:{arguments:{fieldEquals:{folder:"dp-received"}}}}')"
ensure_policy "$(jq -nc '{name:"dp-pipeline: filing outside dp-received needs board approval", description:"Any agent filing to a folder other than dp-received (for example dp-executed) needs board approval; for the signed copy this is the board review. Company-wide.", policyType:"require_approval", priority:9, enabled:true, selectors:{toolNames:["paperclip.loc-agentmail:create_drive_file"]}, conditions:{arguments:{fieldNotEquals:{folder:"dp-received"}}}}')"

echo "== 4. Check"
api GET "/companies/$COMPANY/tools/policies" | jq -r '(.policies // .items // .)[] | select(.name | startswith("dp-pipeline")) | "  \(.priority) \(.policyType) \(.enabled) \(.name)"'
if (( DRY )); then echo "OK (dry run: nothing written)"; else echo "OK"; fi
