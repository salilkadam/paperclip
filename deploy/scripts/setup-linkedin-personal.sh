#!/usr/bin/env bash
# setup-linkedin-personal.sh — give a company's CMO and its marketer the LinkedIn
# personal-account path (Composio LinkedIn app) and prove its gate.
#
# Owner (2026-11-01/02): the CMO and the content marketer must reach LinkedIn
# through the LinkedIn connector as well as Apify, for a board member's personal
# LinkedIn account. The connector is Composio's LinkedIn toolkit, connected in
# Composio by that person (OAuth with their own LinkedIn login).
#
# For every active company with a Composio connection (https://connect.composio.dev/mcp),
# in this order (the gate exists before anyone gets access):
#   1. Runs setup-composio-governance.sh for the company (LinkedIn delete block,
#      LinkedIn write approval, the Reddit/Stack Exchange rules). Fatal if it fails.
#   2. Selects the agents: the one agent named "CMO" and its one direct report
#      (the marketer), exactly like setup-cmo-blog-amplifier.sh. Both are required.
#   3. Ensures both can use the Composio connection: when the connection is not
#      installed company-wide, the install set is read and PUT back whole with the
#      two agents added (PUT replaces the set; never send a partial list).
#   4. Installs (force: updates) the skills `social-core`, `linkedin-marketing`,
#      `linkedin-personal-account` into the company library, then syncs them
#      onto both (mode "add": other skills are kept) and checks they resolve.
#   5. Reports whether a LinkedIn app is connected on the Composio account, after
#      asking the server to refresh its cached view. Informational: not connected
#      is not fatal (skills fall back to Apify/TryPost and tell the board).
#   6. PROVES, as the MARKETER (the agent that acts; under the owner's job-function
#      rule of 2026-11-02, C-level agents delegate tactical work and Composio's
#      multi-execute counts as a write, so a governed CMO is refused there and
#      only reported), with gateway test calls (nothing posts):
#      LINKEDIN_GET_MY_INFO -> allowed (runs only if LinkedIn is connected; a
#      Composio tool_error is still "allowed"); LINKEDIN_CREATE_COMMENT_ON_POST ->
#      ask_first (declined); LINKEDIN_DELETE_UGC_POST -> off;
#      [CREATE in slot 1, DELETE in slot 2] -> off (block beats ask).
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key of an instance admin (`paperclipai token board create --name li-setup --ttl-days 1`).
# Usage: deploy/scripts/setup-linkedin-personal.sh [--company-id <id>] [--dry-run]
set -euo pipefail
API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
COMPOSIO_URL="https://connect.composio.dev/mcp"
SKILLS='["paperclipai/optional/social/social-core","paperclipai/optional/linkedin/linkedin-marketing","paperclipai/optional/linkedin/linkedin-personal-account"]'
ONLY_COMPANY=""; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --company-id) ONLY_COMPANY="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
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
# api METHOD PATH [json-file] -> body; non-2xx fatal.  api_try: same but returns the HTTP code, never dies.
api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-linkedin-personal/2' \
    ${3:+--data-binary @"$3"} --max-time 180 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}
api_try() {
  curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" -H 'Content-Type: application/json' \
    -H 'User-Agent: paperclip-linkedin-personal/2' ${3:+--data-binary @"$3"} --max-time 180 "$API/api$2" || echo 000
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
  [[ -z "$reason" || "$(jq -r '.error.reasonCode // ""' <<<"$resp")" == "$reason" ]] || die "probe '$label': refused, but not with $reason"
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

  # 1. the gate first
  if [[ "$DRY" -eq 0 ]]; then
    PAPERCLIP_API_BASE="$API" PAPERCLIP_BOARD_KEY_FILE="$PAPERCLIP_BOARD_KEY_FILE" "$HERE/setup-composio-governance.sh" --company-id "$cid" \
      || die "$cname: Composio governance failed; no access granted"
  else
    log "  (dry run) would run setup-composio-governance.sh --company-id $cid"
  fi

  # 2. the agents
  agents="$(api GET "/companies/$cid/agents")"
  cmo="$(jq -r '[.[] | select(.name == "CMO" and .status != "terminated")] | if length == 1 then .[0].id else "" end' <<<"$agents")"
  [[ -n "$cmo" ]] || die "$cname: expected exactly one agent named CMO"
  marketer="$(jq -r --arg c "$cmo" '[.[] | select(.reportsTo == $c and .status != "terminated")] | if length == 1 then .[0].id else "" end' <<<"$agents")"
  [[ -n "$marketer" ]] || die "$cname: expected exactly one direct report of the CMO (the marketer)"
  log "  CMO $cmo; marketer $(jq -r --arg m "$marketer" '.[] | select(.id == $m) | .name' <<<"$agents") $marketer"

  # 3. access: PUT the whole install set back with the two agents added
  installs="$(api GET "/tool-connections/$conn/installs" | jq '(.installs // [])')"
  if jq -e 'any(.[]; .targetType=="company")' <<<"$installs" >/dev/null; then
    log "  access ok: connection installed company-wide"
  else
    want="$(jq -c --arg a "$cmo" --arg b "$marketer" '
      [.[] | {targetType, targetId}] as $have
      | $have + ([{targetType:"agent", targetId:$a}, {targetType:"agent", targetId:$b}] | map(select(. as $n | $have | index($n) | not)))' <<<"$installs")"
    if [[ "$(jq length <<<"$want")" -eq "$(jq length <<<"$installs")" ]]; then
      log "  access ok: both agents already installed"
    else
      log "  grant access: PUT ${#want} bytes, $(jq length <<<"$want") installs (was $(jq length <<<"$installs"))"
      jq -n --argjson i "$want" '{installs:$i}' > "$WORK/inst.json"
      [[ "$DRY" -eq 1 ]] || api PUT "/tool-connections/$conn/installs" "$WORK/inst.json" >/dev/null
    fi
  fi

  # 4. skills: install (or update, force) the catalog skills into the company
  #    library first — an optional catalog skill an agent is told to use but the
  #    company never installed resolves as "missing" — then sync onto both agents.
  for k in $(jq -r '.[]' <<<"$SKILLS"); do
    jq -n --arg id "$(tr '/' ':' <<<"$k")" '{catalogSkillId:$id, force:true}' > "$WORK/cat.json"
    if [[ "$DRY" -eq 0 ]]; then
      res="$(api POST "/companies/$cid/skills/install-catalog" "$WORK/cat.json")"
      log "  catalog $k: $(jq -r '.action // "ok"' <<<"$res")"
    else
      log "  (dry run) would install catalog skill $k"
    fi
  done
  jq -n --argjson k "$SKILLS" '{mode:"add", desiredSkills:$k}' > "$WORK/skills.json"
  for aid in "$cmo" "$marketer"; do
    if [[ "$DRY" -eq 0 ]]; then
      synced="$(api POST "/agents/$aid/skills/sync" "$WORK/skills.json")"
      for k in $(jq -r '.[]' <<<"$SKILLS"); do
        jq -e --arg k "$k" '[.entries[]? | select(.key==$k and .desired and (.state=="installed" or .state=="configured" or .state=="available" or .state=="external"))] | length==1' <<<"$synced" >/dev/null \
          || die "$cname: skill $k did not resolve for agent $aid (is the server image new enough to ship it?): $(jq -c --arg k "$k" '[.entries[]? | select(.key==$k)]' <<<"$synced")"
      done
      log "  skills synced: $aid"
    else
      log "  (dry run) would sync $(jq -r 'join(", ")' <<<"$SKILLS") onto $aid"
    fi
  done

  # 5. is LinkedIn connected in Composio? (cached per-user view; refresh first; informational)
  jq -n '{toolkits:["linkedin"]}' > "$WORK/refresh.json"
  code="$(api_try POST "/tool-connections/$conn/composio/apps/refresh" "$WORK/refresh.json")"
  if [[ "$code" =~ ^2 ]] || [[ "$(api_try GET "/tool-connections/$conn/composio/apps")" =~ ^2 ]]; then
    li="$(jq -r '[(.apps // [])[] | select(.toolkit | test("^linkedin$"; "i"))][0] | if . == null then "absent" else .status end' "$WORK/resp")"
    case "$li" in
      absent|not_connected) log "  LinkedIn app NOT connected in Composio ($li). Board step: connect LinkedIn with the member's own login (Composio dashboard, or an agent's COMPOSIO_MANAGE_CONNECTIONS card). Skills fall back to Apify/TryPost until then." ;;
      *) log "  LinkedIn app connected in Composio (status: $li)" ;;
    esac
  else
    log "  LinkedIn-in-Composio status unavailable from this connection (HTTP $code); check the Apps page"
  fi

  # 6. prove the gate as the marketer; report the CMO (job-function policy may refuse it)
  if [[ "$DRY" -eq 0 ]]; then
    jq -n --arg a "$cmo" --argjson p "$(t '[{"tool_slug":"LINKEDIN_GET_MY_INFO","arguments":{}}]')" '{agentId:$a, toolName:"COMPOSIO_MULTI_EXECUTE_TOOL", parameters:$p}' > "$WORK/cmo.json"
    cmo_resp="$(api POST "/tool-connections/$conn/test-calls" "$WORK/cmo.json")"
    log "  CMO via Composio: $(jq -r '.decision' <<<"$cmo_resp")$(jq -r 'if .decision=="off" then " — " + (.error.message // "") + " (expected where the job-function policy applies: the CMO delegates LinkedIn actions to the marketer)" else "" end' <<<"$cmo_resp")"
    probe "$cid" "$conn" "$marketer" "LinkedIn read (my info)" "$(t '[{"tool_slug":"LINKEDIN_GET_MY_INFO","arguments":{}}]')" allowed
    probe "$cid" "$conn" "$marketer" "LinkedIn comment needs approval" "$(t '[{"tool_slug":"LINKEDIN_CREATE_COMMENT_ON_POST","arguments":{"parent_urn":"urn:li:share:probe","text":"governance probe"}}]')" ask_first
    probe "$cid" "$conn" "$marketer" "LinkedIn delete is blocked" "$(t '[{"tool_slug":"LINKEDIN_DELETE_UGC_POST","arguments":{"post_urn":"urn:li:ugcPost:probe"}}]')" off deny_policy_block
    probe "$cid" "$conn" "$marketer" "create then delete: block beats ask" "$(t '[{"tool_slug":"LINKEDIN_CREATE_LINKED_IN_POST","arguments":{"text":"probe"}},{"tool_slug":"LINKEDIN_DELETE_POST","arguments":{"post_urn":"urn:li:share:probe"}}]')" off deny_policy_block
  fi
  total=$((total+1))
done
[[ "$total" -gt 0 ]] || die "no company with a Composio connection"
log "done: $total company(ies)$([[ "$DRY" -eq 1 ]] && echo ' (dry run: no writes, no governance run, no probes)')"
