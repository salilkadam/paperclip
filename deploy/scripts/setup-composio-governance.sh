#!/usr/bin/env bash
# setup-composio-governance.sh — agents never post, comment, vote or submit on
# Reddit or Stack Exchange through Composio, for EVERY active company with a
# Composio connection (https://connect.composio.dev/mcp), idempotently.
#
# Owner's decision (2026-10-28): replies on community sites are human-posted.
# The pipeline drafts a ready-to-paste reply; a person posts it from an
# established account. Composio's connected reddit/stack_exchange toolkits can
# write, and its meta tools were plainly "allowed", so nothing stopped a write.
#
# Since 2026-10-28 the server refuses these writes in code for every Composio
# connection (server/src/services/connectors/composio-guard.ts), before any
# company policy. The policies below are the second layer, and the only place
# the ask-first rule for connecting apps lives.
#
# Per Composio connection it ensures these company policies, by exact name:
#   block  COMPOSIO_MULTI_EXECUTE_TOOL when tools[i].tool_slug (i = 0..3) is a
#          Reddit or Stack Exchange slug whose verb is not SEARCH / RETRIEVE /
#          GET / LIST / FETCH, any letter case, leading whitespace allowed (one
#          policy per site and position). Over-blocks reads with other verbs
#          (e.g. REDDIT_CHECK_USERNAME_AVAILABILITY) on purpose;
#   block  COMPOSIO_MULTI_EXECUTE_TOOL when `tools` is a string instead of an
#          array (the per-position rules could not read it);
#   block  COMPOSIO_MULTI_EXECUTE_TOOL with more than 4 tools (tools[4] exists),
#          so a write cannot hide further down the list (agents send 1);
#   block  COMPOSIO_REMOTE_BASH_TOOL and COMPOSIO_REMOTE_WORKBENCH (sandboxes
#          that can call Composio tools themselves; agents fetch public APIs
#          from their own runtime instead);
#   ask first COMPOSIO_MANAGE_CONNECTIONS (connecting a new app needs the board).
# All at priority 0, so they are evaluated before other rules. A policy that
# exists with a different type, priority, selectors or conditions (or disabled)
# is updated in place. It fails when an enabled "allow" policy could cover the
# connection (an allow wins outright if ordered first), or when the connection's
# catalog has a tool outside KNOWN_TOOLS: these rules name tools, so a new
# Composio meta tool must be reviewed and added here before the script passes.
#
# Not on by default: run it after creating or re-creating any Composio
# connection, in any company. It governs the gateway only. An agent could still
# call Reddit's or Stack Exchange's API from its own runtime with credentials of
# its own; none are provisioned to agents, which is what closes that path.
#
# Then it PROVES the gate with gateway test calls as one of the company's agents.
# Blocked calls never reach Composio; the one allowed probe is a read-only search:
#   - multi-execute REDDIT_POST_REDDIT_COMMENT in slot 1      -> off (deny_policy_block)
#   - multi-execute stack_exchange_create_answer in slot 3    -> off (deny_policy_block)
#   - multi-execute with 5 tools                              -> off (deny_policy_block)
#   - multi-execute " REDDIT_POST_REDDIT_COMMENT" (leading space)-> off (deny_policy_block)
#   - multi-execute with `tools` as a JSON string             -> off (deny_policy_block)
#   - remote bash, remote workbench                           -> off (deny_policy_block)
#   - manage connections                                      -> ask_first (declined)
#   - multi-execute REDDIT_SEARCH_ACROSS_SUBREDDITS           -> allowed
# Any other outcome is fatal.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key of an instance admin. The key never appears on a command line.
#
# Usage: deploy/scripts/setup-composio-governance.sh [--company-id <id>] [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
COMPOSIO_URL="https://connect.composio.dev/mcp"
# a Reddit / Stack Exchange slug that is not a read (SEARCH/RETRIEVE/GET/LIST/FETCH), any letter case.
# The server only accepts patterns without '|', backreferences or nested quantifiers, so: one
# pattern per site, chained single-verb lookaheads, and per-letter classes instead of a flag.
REDDIT_WRITE_RE='^\s*[rR][eE][dD][dD][iI][tT]_(?![sS][eE][aA][rR][cC][hH]_)(?![rR][eE][tT][rR][iI][eE][vV][eE]_)(?![gG][eE][tT]_)(?![lL][iI][sS][tT]_)(?![fF][eE][tT][cC][hH]_)'
STACKEX_WRITE_RE='^\s*[sS][tT][aA][cC][kK]_[eE][xX][cC][hH][aA][nN][gG][eE]_(?![sS][eE][aA][rR][cC][hH]_)(?![rR][eE][tT][rR][iI][eE][vV][eE]_)(?![gG][eE][tT]_)(?![lL][iI][sS][tT]_)(?![fF][eE][tT][cC][hH]_)'
# every tool the connection's catalog may hold; anything else fails the run until reviewed
KNOWN_TOOLS='["COMPOSIO_SEARCH_TOOLS","COMPOSIO_GET_TOOL_SCHEMAS","COMPOSIO_MULTI_EXECUTE_TOOL","COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_WAIT_FOR_CONNECTIONS","COMPOSIO_REMOTE_BASH_TOOL","COMPOSIO_REMOTE_WORKBENCH","COMPOSIO_SEARCH_SKILLS",
  "COMPOSIO_USE_SKILL","COMPOSIO_MANAGE_SKILL","COMPOSIO_SUBMIT_FEEDBACK"]'
ONLY_COMPANY=""; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --company-id) ONLY_COMPANY="${2:?--company-id needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[composio-governance] $*"; }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"

api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-composio-governance/1' \
    ${3:+--data-binary @"$3"} --max-time 180 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}

desired_policies() {
  jq -n --arg conn "$1" --arg reddit "$REDDIT_WRITE_RE" --arg stackex "$STACKEX_WRITE_RE" '
    def multi(name; cond): { name: name,
      description: "Replies on community sites are human-posted (owner, 2026-10-28): no agent writes to Reddit or Stack Exchange through Composio.",
      policyType: "block", priority: 0, enabled: true,
      selectors: { toolNames: ["COMPOSIO_MULTI_EXECUTE_TOOL"], connectionId: $conn }, conditions: cond };
    [ ([["Reddit", $reddit], ["Stack Exchange", $stackex]][]) as [$site, $re] | range(0;4) as $i
        | multi("org-instructions: no \($site) writes via Composio (tool \($i + 1))";
            { arguments: { fieldMatches: { ("tools.\($i).tool_slug"): $re } } }) ]
    + [ multi("org-instructions: Composio multi-execute tools must be a list";
        { arguments: { fieldMatches: { "tools": "^" } } }) ]
    + [ multi("org-instructions: Composio multi-execute carries at most 4 tools";
        { arguments: { fieldExists: ["tools.4"] } }) ]
    + [ { name: "org-instructions: no Composio sandboxes for agents",
          description: "The remote bash and workbench sandboxes can call Composio tools themselves, past the write rules. Agents fetch public APIs from their own runtime.",
          policyType: "block", priority: 0, enabled: true,
          selectors: { toolNames: ["COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_REMOTE_WORKBENCH"], connectionId: $conn }, conditions: null },
        { name: "org-instructions: ask first before connecting a Composio app",
          description: "Connecting a new app through Composio needs the board.",
          policyType: "require_approval", priority: 0, enabled: true,
          selectors: { toolNames: ["COMPOSIO_MANAGE_CONNECTIONS"], connectionId: $conn }, conditions: null } ]'
}

# probe CID CONN AGENT LABEL TOOL PARAMS_JSON EXPECTED_DECISION [EXPECTED_REASON]
probe() {
  local cid="$1" conn="$2" agent="$3" label="$4" tool="$5" params="$6" want="$7" reason="${8:-}" resp decision ar
  jq -n --arg a "$agent" --arg t "$tool" --argjson p "$params" '{agentId:$a, toolName:$t, parameters:$p}' > "$WORK/probe.json"
  resp="$(api POST "/tool-connections/$conn/test-calls" "$WORK/probe.json")"
  decision="$(jq -r '.decision // "none"' <<<"$resp")"
  ar="$(jq -r '.actionRequestId // empty' <<<"$resp")"
  if [[ -n "$ar" ]]; then
    jq -n --arg c "$cid" '{companyId:$c, reason:"composio-governance probe; never meant to run"}' > "$WORK/decline.json"
    api POST "/tool-gateway/action-requests/$ar/decline" "$WORK/decline.json" >/dev/null
  fi
  [[ "$decision" == "$want" ]] || die "probe '$label' on $conn: expected $want, got $decision: $(head -c 300 <<<"$resp")"
  if [[ -n "$reason" ]]; then
    [[ "$(jq -r '.error.reasonCode // ""' <<<"$resp")" == "$reason" ]] || die "probe '$label': refused, but not by the policy (want $reason): $(head -c 300 <<<"$resp")"
  fi
  log "  probe ok: $label -> $decision${reason:+ ($reason)}"
}

companies="$(api GET /companies)"
jq -e 'type=="array"' <<<"$companies" >/dev/null || companies="$(jq '.companies // .items' <<<"$companies")"
companies="$(jq '[.[] | select((.status // "active") != "archived")]' <<<"$companies")"
[[ -z "$ONLY_COMPANY" ]] || companies="$(jq --arg id "$ONLY_COMPANY" '[.[] | select(.id==$id)]' <<<"$companies")"
[[ "$(jq length <<<"$companies")" -gt 0 ]] || die "no matching active company visible to this board key"

total=0
for cid in $(jq -r '.[].id' <<<"$companies"); do
  cname="$(jq -r --arg id "$cid" '.[]|select(.id==$id)|.name' <<<"$companies")"
  conns="$(api GET "/companies/$cid/tools/connections" | jq --arg u "$COMPOSIO_URL" '(.connections // .) | [.[] | select(.status=="active" and ((.config.url // .url // "") == $u))]')"
  if [[ "$(jq length <<<"$conns")" -eq 0 ]]; then log "$cname: no active Composio connection, skipped"; continue; fi
  agent="$(api GET "/companies/$cid/agents" | jq -r '[.[] | select(.status=="idle" or .status=="active" or .status=="running")][0].id // empty')"
  [[ -n "$agent" ]] || die "$cname has a Composio connection but no agent to prove the gate with"
  existing="$(api GET "/companies/$cid/tools/policies" | jq '(.policies // .)')"
  for conn in $(jq -r '.[].id' <<<"$conns"); do
    log "$cname: Composio connection $conn"
    unknown="$(api GET "/tool-connections/$conn/catalog" | jq -c --argjson k "$KNOWN_TOOLS" '
      (.catalog | if type == "array" then . else (.tools // .entries // []) end)
      | [.[] | select((.status // "active") == "active") | (.name // .toolName) | select(. as $n | $k | index($n) | not)]')"
    [[ "$unknown" == "[]" ]] || die "$cname: Composio catalog has tools these rules do not cover: $unknown (review them, then add to KNOWN_TOOLS)"
    allows="$(jq -c --arg conn "$conn" '[.[] | select(.policyType == "allow" and .enabled
      and ((.selectors.connectionId // null) == null or .selectors.connectionId == $conn)) | .name]' <<<"$existing")"
    [[ "$allows" == "[]" ]] || die "$cname: enabled allow policies could pre-empt the Composio blocks: $allows"
    desired_policies "$conn" | jq -c '.[]' | while read -r want; do
      name="$(jq -r .name <<<"$want")"
      have="$(jq -c --arg n "$name" --arg conn "$conn" '[.[] | select(.name==$n and .selectors.connectionId==$conn)][0] // empty' <<<"$existing")"
      if [[ -z "$have" ]]; then
        log "  create: $name"
        [[ "$DRY" -eq 1 ]] || { printf '%s' "$want" > "$WORK/p.json"; api POST "/companies/$cid/tools/policies" "$WORK/p.json" >/dev/null; }
      elif ! jq -e --argjson w "$want" '(.policyType==$w.policyType) and (.enabled==true) and (.priority==$w.priority)
               and ((.selectors | .toolNames |= sort)==($w.selectors | .toolNames |= sort))
               and (.conditions==$w.conditions)' <<<"$have" >/dev/null; then
        log "  update (drifted): $name"
        [[ "$DRY" -eq 1 ]] || { printf '%s' "$want" > "$WORK/p.json"; api PATCH "/companies/$cid/tools/policies/$(jq -r .id <<<"$have")" "$WORK/p.json" >/dev/null; }
      else
        log "  ok: $name"
      fi
    done
    if [[ "$DRY" -eq 0 ]]; then
      t() { jq -cn --argjson tools "$1" '{session_id:"governance-probe", tools:$tools, thought:"governance probe", current_step:"PROBE", sync_response_to_workbench:false}'; }
      probe "$cid" "$conn" "$agent" "Reddit comment in tool 1" COMPOSIO_MULTI_EXECUTE_TOOL \
        "$(t '[{"tool_slug":"REDDIT_POST_REDDIT_COMMENT","arguments":{"thing_id":"t3_governanceprobe","text":"probe"}}]')" off deny_policy_block
      probe "$cid" "$conn" "$agent" "Stack Exchange write in tool 3, lower case" COMPOSIO_MULTI_EXECUTE_TOOL \
        "$(t '[{"tool_slug":"REDDIT_SEARCH_ACROSS_SUBREDDITS","arguments":{"search_query":"x"}},{"tool_slug":"STACK_EXCHANGE_SEARCH_ADVANCED","arguments":{"q":"x"}},{"tool_slug":"stack_exchange_create_answer","arguments":{"body":"probe"}}]')" off deny_policy_block
      probe "$cid" "$conn" "$agent" "five tools in one call" COMPOSIO_MULTI_EXECUTE_TOOL \
        "$(t '[{"tool_slug":"A"},{"tool_slug":"B"},{"tool_slug":"C"},{"tool_slug":"D"},{"tool_slug":"E"}]')" off deny_policy_block
      probe "$cid" "$conn" "$agent" "Reddit comment with a leading space" COMPOSIO_MULTI_EXECUTE_TOOL \
        "$(t '[{"tool_slug":" REDDIT_POST_REDDIT_COMMENT","arguments":{"thing_id":"t3_governanceprobe","text":"probe"}}]')" off deny_policy_block
      probe "$cid" "$conn" "$agent" "tools as a JSON string" COMPOSIO_MULTI_EXECUTE_TOOL \
        "$(jq -cn '{session_id:"governance-probe", tools:"[{\"tool_slug\":\"REDDIT_POST_REDDIT_COMMENT\",\"arguments\":{}}]", thought:"governance probe", current_step:"PROBE", sync_response_to_workbench:false}')" off deny_policy_block
      probe "$cid" "$conn" "$agent" "remote bash" COMPOSIO_REMOTE_BASH_TOOL '{"session_id":"governance-probe","command":"true"}' off deny_policy_block
      probe "$cid" "$conn" "$agent" "remote workbench" COMPOSIO_REMOTE_WORKBENCH '{"session_id":"governance-probe","code_to_execute":"pass","thought":"probe","current_step":"PROBE"}' off deny_policy_block
      probe "$cid" "$conn" "$agent" "manage connections" COMPOSIO_MANAGE_CONNECTIONS '{"session_id":"governance-probe","toolkits":["reddit"]}' ask_first
      probe "$cid" "$conn" "$agent" "read-only Reddit search" COMPOSIO_MULTI_EXECUTE_TOOL \
        "$(t '[{"tool_slug":"REDDIT_SEARCH_ACROSS_SUBREDDITS","arguments":{"search_query":"subreddit:kubernetes","time_filter":"day","limit":1}}]')" allowed
    fi
    total=$((total + 1))
  done
done
[[ "$total" -gt 0 ]] || die "no active Composio connection found in any target company (nothing governed)"
log "done: $total Composio connection(s) governed$([[ "$DRY" -eq 1 ]] && echo ' (dry run, no writes, no probes)')"
