#!/usr/bin/env bash
# setup-linkedin-personal.sh — give a company's CMO and content/growth marketer
# the LinkedIn personal-account path (Composio LinkedIn app) and prove its gate.
#
# Owner (2026-11-01/02): the CMO and the content marketer must reach LinkedIn
# through the LinkedIn connector as well as Apify, for a board member's personal
# LinkedIn account. The connector is Composio's LinkedIn toolkit, connected in
# Composio by that person (OAuth with their own LinkedIn login).
#
# For every active company with a Composio connection (https://connect.composio.dev/mcp):
#   1. Reports whether a LinkedIn app is connected on that Composio account
#      (GET /tool-connections/:id/composio/apps). Not connected is NOT fatal: the
#      skills fall back to Apify/TryPost and tell the board what to connect.
#   2. Ensures the named agents (by role: cmo + content-marketer/growth-marketer,
#      matched on agent name, case-insensitive; override with --agents) can use
#      the Composio connection: adds an agent install when the connection is
#      installed per agent (a company-wide install already covers them).
#   3. Syncs the skills `linkedin-personal-account` + `linkedin-marketing` +
#      `social-core` onto each of those agents (mode "add", existing skills kept)
#      and checks they resolve.
#   4. Runs setup-composio-governance.sh for that company (LinkedIn delete block,
#      write approval, existing Reddit/Stack Exchange rules) — the gate.
#   5. PROVES, as the CMO: LINKEDIN_GET_MY_INFO -> allowed (it only runs if
#      LinkedIn is connected; a tool_error from Composio is still "allowed"),
#      LINKEDIN_CREATE_COMMENT_ON_POST -> ask_first (declined), LINKEDIN_DELETE_UGC_POST -> off.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key of an instance admin (`paperclipai token board create --name li-setup --ttl-days 1`).
# Usage: deploy/scripts/setup-linkedin-personal.sh [--company-id <id>] [--agents "name1,name2"] [--dry-run]
set -euo pipefail
API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
COMPOSIO_URL="https://connect.composio.dev/mcp"
SKILLS='["paperclipai/optional/social/social-core","paperclipai/optional/linkedin/linkedin-marketing","paperclipai/optional/linkedin/linkedin-personal-account"]'
ROLE_RE='^(cmo|chief marketing|content marketer|content-marketer|growth ?marketer)'
ONLY_COMPANY=""; AGENT_NAMES=""; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --company-id) ONLY_COMPANY="${2:?}"; shift 2 ;;
    --agents) AGENT_NAMES="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[linkedin-personal] $*"; }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"
api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-linkedin-personal/1' \
    ${3:+--data-binary @"$3"} --max-time 180 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}
probe() { # probe CID CONN AGENT LABEL PARAMS_JSON EXPECTED [REASON]
  local cid="$1" conn="$2" agent="$3" label="$4" params="$5" want="$6" reason="${7:-}" resp decision ar
  jq -n --arg a "$agent" --argjson p "$params" '{agentId:$a, toolName:"COMPOSIO_MULTI_EXECUTE_TOOL", parameters:$p}' > "$WORK/probe.json"
  resp="$(api POST "/tool-connections/$conn/test-calls" "$WORK/probe.json")"
  decision="$(jq -r '.decision // "none"' <<<"$resp")"
  ar="$(jq -r '.actionRequestId // empty' <<<"$resp")"
  if [[ -n "$ar" ]]; then
    jq -n --arg c "$cid" '{companyId:$c, reason:"linkedin-personal probe; never meant to run"}' > "$WORK/decline.json"
    api POST "/tool-gateway/action-requests/$ar/decline" "$WORK/decline.json" >/dev/null
  fi
  [[ "$decision" == "$want" ]] || die "probe '$label': expected $want, got $decision: $(head -c 300 <<<"$resp")"
  [[ -z "$reason" || "$(jq -r '.error.reasonCode // ""' <<<"$resp")" == "$reason" ]] || die "probe '$label': refused, but not by the policy"
  log "  probe ok: $label -> $decision"
}
t() { jq -cn --argjson tools "$1" '{session_id:"linkedin-probe", tools:$tools, thought:"governance probe", current_step:"PROBE", sync_response_to_workbench:false}'; }

companies="$(api GET /companies)"
jq -e 'type=="array"' <<<"$companies" >/dev/null || companies="$(jq '.companies // .items' <<<"$companies")"
companies="$(jq '[.[] | select((.status // "active") != "archived")]' <<<"$companies")"
[[ -z "$ONLY_COMPANY" ]] || companies="$(jq --arg id "$ONLY_COMPANY" '[.[] | select(.id==$id)]' <<<"$companies")"
[[ "$(jq length <<<"$companies")" -gt 0 ]] || die "no matching active company"
total=0
for cid in $(jq -r '.[].id' <<<"$companies"); do
  cname="$(jq -r --arg id "$cid" '.[]|select(.id==$id)|.name' <<<"$companies")"
  conn="$(api GET "/companies/$cid/tools/connections" | jq -r --arg u "$COMPOSIO_URL" '(.connections // .) | [.[] | select(.status=="active" and ((.config.url // .url // "") == $u))][0].id // empty')"
  if [[ -z "$conn" ]]; then log "$cname: no active Composio connection, skipped"; continue; fi
  log "$cname: Composio connection $conn"
  li="$(api GET "/tool-connections/$conn/composio/apps" | jq -r '[(.apps // [])[] | select(.toolkit | test("^linkedin$"; "i"))][0] | if . == null then "absent" else .status end')"
  case "$li" in
    absent|not_connected) log "  LinkedIn app NOT connected in Composio ($li). Board step: connect LinkedIn with the member's own login (Composio dashboard, or an agent's COMPOSIO_MANAGE_CONNECTIONS card). Skills fall back to Apify/TryPost until then." ;;
    *) log "  LinkedIn app connected in Composio (status: $li)" ;;
  esac
  agents_all="$(api GET "/companies/$cid/agents" | jq -c '[.[] | select(.status=="idle" or .status=="active" or .status=="running") | {id, name}]')"
  if [[ -n "$AGENT_NAMES" ]]; then
    targets="$(jq -c --arg n "$AGENT_NAMES" '[.[] | select(.name as $x | ($n | split(",") | map(ascii_downcase | gsub("^ +| +$";"")) | index($x | ascii_downcase)) != null)]' <<<"$agents_all")"
  else
    targets="$(jq -c --arg re "$ROLE_RE" '[.[] | select(.name | ascii_downcase | test($re))]' <<<"$agents_all")"
  fi
  [[ "$(jq length <<<"$targets")" -gt 0 ]] || die "$cname: no CMO / content-marketer / growth-marketer agent found (agents: $(jq -r '[.[].name]|join(", ")' <<<"$agents_all")); use --agents"
  log "  agents: $(jq -r '[.[].name]|join(", ")' <<<"$targets")"
  installs="$(api GET "/tool-connections/$conn/installs")"
  company_wide="$(jq -r '(.installs // []) | any(.targetType=="company")' <<<"$installs")"
  for aid in $(jq -r '.[].id' <<<"$targets"); do
    if [[ "$company_wide" == true ]] || jq -e --arg a "$aid" '(.installs // []) | any(.targetType=="agent" and .targetId==$a)' <<<"$installs" >/dev/null; then
      log "  access ok: $aid"
    else
      log "  grant access: $aid"
      jq -n --arg a "$aid" '{targetType:"agent", targetId:$a}' > "$WORK/inst.json"
      [[ "$DRY" -eq 1 ]] || api POST "/tool-connections/$conn/installs" "$WORK/inst.json" >/dev/null
    fi
    jq -n --argjson k "$SKILLS" '{mode:"add", keys:$k}' > "$WORK/skills.json"
    if [[ "$DRY" -eq 0 ]]; then
      synced="$(api POST "/agents/$aid/skills/sync" "$WORK/skills.json")"
      for k in $(jq -r '.[]' <<<"$SKILLS"); do
        jq -e --arg k "$k" '[.entries[]? | select(.key==$k and .desired and (.state=="installed" or .state=="configured" or .state=="available" or .state=="external"))] | length==1' <<<"$synced" >/dev/null \
          || die "$cname: skill $k did not resolve for agent $aid (is the server image new enough to ship it?)"
      done
      log "  skills synced: $aid"
    fi
  done
  if [[ "$DRY" -eq 0 ]]; then
    PAPERCLIP_API_BASE="$API" PAPERCLIP_BOARD_KEY_FILE="$PAPERCLIP_BOARD_KEY_FILE" "$HERE/setup-composio-governance.sh" --company-id "$cid"
    cmo="$(jq -r '.[0].id' <<<"$targets")"
    probe "$cid" "$conn" "$cmo" "LinkedIn read (my info)" "$(t '[{"tool_slug":"LINKEDIN_GET_MY_INFO","arguments":{}}]')" allowed
    probe "$cid" "$conn" "$cmo" "LinkedIn comment needs approval" "$(t '[{"tool_slug":"LINKEDIN_CREATE_COMMENT_ON_POST","arguments":{"parent_urn":"urn:li:share:probe","text":"governance probe"}}]')" ask_first
    probe "$cid" "$conn" "$cmo" "LinkedIn delete is blocked" "$(t '[{"tool_slug":"LINKEDIN_DELETE_UGC_POST","arguments":{"post_urn":"urn:li:ugcPost:probe"}}]')" off deny_policy_block
  fi
  total=$((total+1))
done
[[ "$total" -gt 0 ]] || die "no company with a Composio connection"
log "done: $total company(ies)$([[ "$DRY" -eq 1 ]] && echo ' (dry run: no writes, no governance run, no probes)')"
