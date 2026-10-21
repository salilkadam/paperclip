#!/usr/bin/env bash
# setup-ghost-connections.sh — connect each company to ITS OWN Ghost blog through
# the ghost MCP server (https://mcp.baisoln.com/ghost/mcp), idempotently.
#
#   Company "Bionic AI Solutions" -> site "bionic"  (blog-bionic.baisoln.com)
#   Company "Reliora …"           -> site "reliora" (blog-reliora.baisoln.com)
#
# Per company it:
#   1. resolves the company by name (exactly one match, or it stops);
#   2. creates an Apps v2 remote-MCP connection "Ghost blog" with an
#      X-API-Key header. The value is that company's OWN gateway key, read from
#      Vault t6-apps/mcp/config:apikey_ghost_<site>_key, and Paperclip stores it
#      as a company secret (write-only; never read back);
#   3. gives every agent in the company access ("finish"): reads, drafts, edits,
#      tags and image upload enabled; gh_publish_post, gh_unpublish_post and
#      gh_delete_post are ASK FIRST (board approval card before they run);
#   4. proves it with a real test call as one of the company's agents:
#      gh_list_sites must return exactly that company's site.
#
# Isolation is enforced by the MCP server, not by this script: each site lists
# only its company's Kong consumer in allowed_consumers (Deploy repo,
# deploy-ghost.sh). A Bionic agent's key is refused on the Reliora blog.
#
# Re-running: an existing active "Ghost blog" connection is left as it is
# (access is re-applied). Pass --rotate to push the current Vault key again.
#
# Requires: curl jq kubectl; env VAULT_TOKEN (from /workspace/.env) and
# PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API key of an instance
# admin (create one: Paperclip UI → Settings → API keys, or
# `paperclipai token board create --name ghost-setup --ttl-days 1`).
# Neither secret ever appears on a command line.
#
# Usage: deploy/scripts/setup-ghost-connections.sh [--rotate] [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
MCP_URL="${GHOST_MCP_URL:-https://mcp.baisoln.com/ghost/mcp}"
CONN_NAME="Ghost blog"
ASK_FIRST=(gh_publish_post gh_unpublish_post gh_delete_post)
# The exact tool set this script may approve. A tool the server adds later is
# NOT auto-approved: the run stops and names it, so a human reviews it first.
KNOWN_TOOLS=(gh_list_sites gh_site_info gh_list_posts gh_get_post gh_create_post gh_update_post
             gh_publish_post gh_unpublish_post gh_delete_post gh_list_tags gh_create_tag gh_upload_image)
# site:company-name-match (case-insensitive prefix; must match exactly one company)
SITES=("bionic:Bionic AI Solutions" "reliora:Reliora")
ROTATE=0; DRY=0
for a in "$@"; do
  case "$a" in
    --rotate) ROTATE=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[ghost-connections] $*"; }
for b in curl jq kubectl; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -n "${VAULT_TOKEN:-}" ]] || die "VAULT_TOKEN is not set"
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
# curl reads the Authorization header from a file (-H @file): the key never
# reaches argv.
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"

# api METHOD PATH [json-file]  -> body on stdout; non-2xx is fatal with the body.
api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-ghost-setup/1' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}

vault_get() {  # value on stdout; absent or unreadable is fatal
  local v
  v="$(printf '%s\n' "$VAULT_TOKEN" | timeout 60 kubectl exec -i -n vault vault-0 -- sh -c \
    'read -r VAULT_TOKEN; export VAULT_TOKEN VAULT_ADDR=http://127.0.0.1:8200; vault kv get -field="$2" "secret/$1"' \
    _ "$1" "$2")" || die "cannot read Vault $1:$2"
  [[ -n "$v" ]] || die "Vault $1:$2 is empty"
  printf '%s' "$v"
}

companies="$(api GET /companies)"
jq -e 'type=="array"' <<<"$companies" >/dev/null || companies="$(jq '.companies // .items' <<<"$companies")"

for entry in "${SITES[@]}"; do
  site="${entry%%:*}"; match="${entry#*:}"
  cid="$(jq -r --arg m "$match" '[.[] | select((.name|ascii_downcase)|startswith($m|ascii_downcase))] |
          if length==1 then .[0].id else "MULTI:\(length)" end' <<<"$companies")"
  [[ "$cid" != MULTI:* ]] || die "company match '$match' found ${cid#MULTI:} companies (need exactly 1)"
  cname="$(jq -r --arg id "$cid" '.[]|select(.id==$id)|.name' <<<"$companies")"
  log "$site -> company '$cname' ($cid)"

  existing="$(api GET "/companies/$cid/tools/connections" | jq -c --arg n "$CONN_NAME" \
    '[(if type=="array" then . else .connections end)[] | select(.name==$n and .status!="archived")]')"
  [[ "$(jq length <<<"$existing")" -le 1 ]] || die "$cname has more than one '$CONN_NAME' connection; archive the extras"
  conn_id="$(jq -r '.[0].id // empty' <<<"$existing")"

  if [[ -z "$conn_id" || $ROTATE -eq 1 ]]; then
    [[ $DRY -eq 1 ]] && { log "  dry-run: would ${conn_id:+re}connect"; continue; }
    key="$(vault_get t6-apps/mcp/config "apikey_ghost_${site}_key")"
    # The key reaches jq through its environment (env.*), never through argv.
    GHOST_GATEWAY_KEY="$key" jq -n --arg link "$MCP_URL" --arg name "$CONN_NAME" --arg re "$conn_id" '
      {link:$link, name:$name, authMode:"custom_headers", grantKind:"organization",
       credentialValues:{"headers.X-API-Key":env.GHOST_GATEWAY_KEY}}
      + (if $re != "" then {reconnectConnectionId:$re} else {} end)' > "$WORK/connect.json"
    unset key
    out="$(api POST "/companies/$cid/tools/apps/connect" "$WORK/connect.json")"
    rm -f "$WORK/connect.json"
    conn_id="$(jq -r '.connectionId' <<<"$out")"
    [[ -n "$conn_id" && "$conn_id" != null ]] || die "connect returned no connectionId"
    log "  connection $conn_id ($([[ $ROTATE -eq 1 ]] && echo 'current Vault key pushed' || echo created))"
  else
    log "  connection $conn_id exists; re-applying access"
    [[ $DRY -eq 1 ]] && continue
  fi

  api POST "/tool-connections/$conn_id/catalog/refresh" >/dev/null
  catalog="$(api GET "/tool-connections/$conn_id/catalog" | jq -c '.entries // .catalog // .')"
  jq -e 'type=="array" and length>0 and all(.[]; (.toolName|type)=="string" and (.id|type)=="string")' <<<"$catalog" >/dev/null \
    || die "$cname: catalog entries must all carry string toolName and id"
  known_json="$(printf '%s\n' "${KNOWN_TOOLS[@]}" | jq -R . | jq -s .)"
  unknown="$(jq -r --argjson k "$known_json" '[.[].toolName | select(. as $t | $k | index($t) | not)] | join(", ")' <<<"$catalog")"
  [[ -z "$unknown" ]] || die "$cname: catalog has tools this script does not know: $unknown — review them in Paperclip (Apps) or add them to KNOWN_TOOLS"
  missing="$(jq -r --argjson k "$known_json" '[$k[] as $t | select([.[].toolName] | index($t) | not) | $t] | join(", ")' <<<"$catalog")"
  [[ -z "$missing" ]] || die "$cname: catalog lacks expected tools: $missing"
  ask_json="$(printf '%s\n' "${ASK_FIRST[@]}" | jq -R . | jq -s .)"
  jq -n --argjson c "$catalog" --argjson ask "$ask_json" '{
      access: "all_agents",
      enabledCatalogEntryIds: [$c[] | select((.toolName as $t | $ask | index($t)) | not) | .id],
      askFirstCatalogEntryIds: [$c[] | select(.toolName as $t | $ask | index($t)) | .id],
      reviewedCatalogEntryIds: [$c[] | select(.status=="quarantined") | .id]}' > "$WORK/finish.json"
  [[ "$(jq '.askFirstCatalogEntryIds|length' "$WORK/finish.json")" -eq ${#ASK_FIRST[@]} ]] || die "ask-first tools missing from catalog"
  api POST "/companies/$cid/tools/apps/$conn_id/finish" "$WORK/finish.json" >/dev/null
  log "  access: all agents; ask first: ${ASK_FIRST[*]}"

  # Proof through the real path, as one of the company's agents.
  agent="$(api GET "/companies/$cid/agents" | jq -r '[(if type=="array" then . else .agents end)[] | select(.status!="terminated")][0].id // empty')"
  [[ -n "$agent" ]] || die "$cname has no agent to test with"
  jq -n --arg a "$agent" '{agentId:$a, toolName:"gh_list_sites", parameters:{}}' > "$WORK/test.json"
  res="$(api POST "/tool-connections/$conn_id/test-calls" "$WORK/test.json")"
  sites="$(jq -c '[.. | objects | select(has("sites")) | .sites[]?.tenant_id] | unique' <<<"$res" 2>/dev/null || echo '[]')"
  if [[ "$sites" != "[\"$site\"]" ]]; then
    # Some responses carry the MCP result as JSON text; parse that too.
    sites="$(jq -r '.. | strings | select(test("tenant_id"))' <<<"$res" | jq -sc '[.[] | fromjson? | .. | objects | select(has("sites")) | .sites[]?.tenant_id] | unique' 2>/dev/null || echo '[]')"
  fi
  [[ "$sites" == "[\"$site\"]" ]] || die "$cname: test call should see only [\"$site\"], saw $sites: $(head -c 300 <<<"$res")"
  log "  verified: agent $agent sees only site '$site'"
done
log "done"
