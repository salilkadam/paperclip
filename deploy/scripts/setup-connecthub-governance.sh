#!/usr/bin/env bash
# setup-connecthub-governance.sh — apply the owner's agent rules to every Connect Hub connection, for EVERY
# active company that has one, idempotently. Run with --dry-run first.
#
# Owner's rules (2026-11-04):
#   - C-level agents read everything and write only to Google Drive and Slack (channels, the board); Slack
#     through their own Paperclip Slack bot (owner, 2026-11-04), not the hub. They assign
#     work to their own agents, and to a peer C-level for cross-functional work (e.g. a web page from the CMO or
#     Content Marketer goes to the Sr. Engineer through the CIO).
#   - Working agents write with the tools of their function. Status updates to Slack go through the C-level they
#     report to, never straight to Slack.
#   - Plus the standing rules: repo writes belong to engineering; community posting (Reddit, Stack Exchange) is
#     human-only; publishing to social channels, sending email, connecting a new app and anything destructive need
#     the board; no agent posts to Slack as a person.
#
# A router-mode Connect Hub server runs each app action through one of three tools, each limited by the hub to one
# risk class: hub_read (read-only actions), hub_execute (writes; refuses destructive ones) and
# hub_execute_destructive (deletes, archives, raw API calls and everything else the hub marks destructive). The app
# is the prefix of the "tool" argument ("<app>.<action>"). No policy here touches hub_read, so every agent reads.
#
# Per Connect Hub connection (lower priority = evaluated first; the first matching policy decides). "exec" means
# hub_execute and hub_execute_destructive:
#    6 block      exec on Reddit, on Stack Exchange                 everyone (community posts are human-only)
#    7 allow      hub_execute on GitHub (engineering); their destructive GitHub actions ask the board
#    7 block      exec outside Google Drive/Docs/Sheets/Slides      C-level agents
#    8 block      exec on Slack                                     everyone: C-level agents post with their own
#                                                                   Paperclip Slack bot, working agents report on
#                                                                   their task (and no agent can post as the person
#                                                                   who connected Slack to the hub)
#    8 block      exec on GitHub                                    everyone else, including agents hired later
#    9 ask first  hub_connect                                       everyone (a person connects each app)
#    9 ask first  hub_execute_destructive                           everyone, C-level included
#   10 allow      hub_execute                                       C-level agents (only Drive gets here)
#   21 ask first  exec on LinkedIn, Facebook Pages, Instagram, YouTube, Google Business Profile   publishing
#   21 ask first  hub_execute sending, replying, forwarding or requesting approval in Gmail       external email
# Anything else follows the agent's installs (their function's tools). The server accepts no "|" in a pattern, so
# each app or verb is its own policy, and "outside" is a chain of negative lookaheads. In router mode only
# hub_connect makes a connect link, so the board gate on connecting an app cannot be bypassed.
#
# Deploying a hub that changes hub_execute's definition puts it back on hold in Paperclip: C-level Drive
# writes stop until the board reviews it (Apps > Connect Hub > Tools). Refresh and review right after the
# deploy.
#
# C-level and engineering are classified exactly as setup-agent-job-function-access.sh does (role ceo/cto/cmo/cfo,
# a "Chief ... Officer" title or a C?O name; engineering = role engineer/devops/qa). Re-run after each hire: the
# agent lists are explicit: an agent hired later gets no GitHub until then. A policy that exists with a different type, priority, selectors or conditions (or
# disabled) is updated in place; an older "connect-hub: ..." policy this version no longer wants is disabled.
#
# Before writing, each connection's catalog must be a router-mode hub that has hub_execute_destructive (an older
# hub runs deletes through hub_execute, which these rules would not gate); a direct-mode server ("<app>__<action>"
# tools) is refused. Then it PROVES the rules with gateway test calls, using tool slugs that do not exist on the
# hub ("<app>.zz_governance_probe"), so an allowed call fails at the hub and nothing changes; the ask-first requests
# the probes create are declined at once. A block is proven only when the policy denied it; a probe agent with no
# access to the connection is reported as not proven. Probes wait until the board has reviewed hub_execute and
# hub_execute_destructive (Paperclip holds both for review).
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API key of an instance admin who is a
# member of the companies (`paperclipai token board create --name connecthub-governance --ttl-days 1`).
# Usage: deploy/scripts/setup-connecthub-governance.sh [--company-id <id>] [--dry-run]
set -euo pipefail
shopt -s inherit_errexit # a failure inside $(...) stops the script too

API="${PAPERCLIP_API_URL:-https://org.baisoln.com}"
ONLY_COMPANY=""; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --company-id) ONLY_COMPANY="${2:?--company-id needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[connecthub-governance] $*"; }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"

# api METHOD PATH [json-file]  -> body on stdout; non-2xx is fatal with the body.
api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-connecthub-governance/1' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}

# isSafePolicyRegex in server/src/services/tool-access-policy.ts, which rejects a policy at create time.
safe_regex() { jq -en --arg p "$1" '($p | length) <= 256 and ($p | test("\\\\[1-9]") | not)
  and ($p | test("(^|[^\\\\])\\|") | not) and ($p | test("\\((?:[^()\\\\]|\\\\.)*[+*](?:[^()\\\\]|\\\\.)*\\)[+*{]") | not)' >/dev/null; }

# app ACTION-PATTERN -> "^<app>\.<pattern>" (the app as a literal prefix).
app_re() { printf '^%s\\.%s' "$(sed 's/[.]/\\./g' <<<"$1")" "${2:-}"; }
C_LEVEL_WRITE_APPS="google-drive google-docs google-sheets google-slides"
SOCIAL_APPS="linkedin facebook-pages instagram-business youtube google-my-business"
# "outside the C-level write apps": negative lookaheads, one per app.
NOT_C_LEVEL_APP="^$(for a in $C_LEVEL_WRITE_APPS; do printf '(?!%s\\.)' "$a"; done)"
# Sends, replies, forwards and approval mails go out; drafts (create_draft, create_draft_reply) do not.
gmail_re() { printf '^gmail\\.(?!(?:gmail_)?create_draft)(?:.*[_-])?%s(?:[_-].*)?$' "$1"; }
EMAIL_VERBS="send reply forward request_approval"

# desired_policies CONNECTION CLEVEL_IDS ENGINEER_IDS WORKER_IDS -> JSON array.
desired_policies() { # (WORKER_IDS is unused: Slack and GitHub are closed to everyone by default)
  local social email
  social="$(for a in $SOCIAL_APPS; do jq -cn --arg a "$a" --arg re "$(app_re "$a")" '[$a, $re]'; done | jq -cs .)"
  email="$(for v in $EMAIL_VERBS; do jq -cn --arg v "$v" --arg re "$(gmail_re "$v")" '[$v, $re]'; done | jq -cs .)"
  jq -n --arg conn "$1" --argjson c "$2" --argjson e "$3" --argjson w "$4" --argjson social "$social" --argjson email "$email" \
    --arg reddit "$(app_re reddit)" --arg stackex "$(app_re stackexchange)" --arg slack "$(app_re slack)" \
    --arg github "$(app_re github)" \
    --arg notc "$NOT_C_LEVEL_APP" '
    def exec: ["hub_execute", "hub_execute_destructive"];
    def p($name; $desc; $type; $prio; $tools; $agents; $args):
      { name: ("connect-hub: " + $name), description: $desc, policyType: $type, priority: $prio, enabled: true,
        selectors: ({ toolNames: $tools, connectionId: $conn } + (if $agents then { agentIds: $agents } else {} end)),
        conditions: (if $args then { arguments: $args } else null end) };
    def tool($re): { fieldMatches: { tool: $re } };
    [ p("no Reddit posting"; "Owner: replies on Reddit are human-posted; agents draft them."; "block"; 6; exec; null; tool($reddit)),
      p("no Stack Exchange posting"; "Owner: answers on Stack Exchange are human-posted; agents draft them."; "block"; 6; exec; null; tool($stackex)),
      # GitHub is closed to everyone at 8, so an agent hired after this run is blocked until it is classified;
      # these open it for engineering (writes allowed, destructive needs the board).
      p("engineering agents write to GitHub"; "Repo writes are the engineering job function.";
        "allow"; 7; ["hub_execute"]; $e; tool($github)),
      p("engineering destructive GitHub actions need the board"; "Deletes, locks and raw API calls on GitHub need board approval.";
        "require_approval"; 7; ["hub_execute_destructive"]; $e; tool($github)),
      p("no Slack through the hub"; "Owner: C-level agents post to Slack with their own Paperclip Slack bot; working agents report on their task and their C-level posts. Read Slack with hub_read.";
        "block"; 8; exec; null; tool($slack)),
      p("GitHub writes belong to engineering"; "Create a task for engineering (through your C-level for cross-functional work). Read GitHub with hub_read.";
        "block"; 8; exec; null; tool($github)),
      p("C-level agents write only to Google Drive"; "Owner: C-level agents read everything (hub_read); through the hub they write only to Google Drive (Slack goes through their own Slack bot); they assign other work.";
        "block"; 7; exec; $c; tool($notc)),
      p("connecting an app needs the board"; "A person connects each app; the board approves first.";
        "require_approval"; 9; ["hub_connect"]; null; null),
      p("destructive actions need the board"; "Deletes, archives, raw API calls and every other action the hub marks destructive need board approval, for every agent.";
        "require_approval"; 9; ["hub_execute_destructive"]; null; null),
      p("C-level agents write to Google Drive"; "Owner: C-level agents write to Google Drive (everything else is blocked at priority 7).";
        "allow"; 10; ["hub_execute"]; $c; null) ]
    + [ $social[] as [$app, $re] | p("publishing to \($app) needs the board"; "Agents draft; the board approves each post."; "require_approval"; 21; exec; null; tool($re)) ]
    + [ $email[] as [$verb, $re] | p("Gmail \($verb) needs the board"; "Email that leaves the company needs board approval; drafts do not."; "require_approval"; 21; ["hub_execute"]; null; tool($re)) ]
    # An agent list must never be empty: an empty agentIds selector would match nobody or everybody.
    | map(select(.selectors.agentIds == null or (.selectors.agentIds | length) > 0))'
}

# Every pattern must pass the server check (a rejected one would stop a live run half way).
self_check() {
  local re
  while read -r re; do safe_regex "$re" || die "policy pattern the server would reject: $re"; done < <(
    desired_policies 00000000-0000-0000-0000-000000000000 '["c"]' '["e"]' '["w"]' | jq -r '.[].conditions.arguments.fieldMatches.tool // empty')
}
self_check

ensure_policy() { # ensure_policy CID EXISTING_JSON WANT_JSON
  local cid="$1" existing="$2" want="$3" name have
  name="$(jq -r .name <<<"$want")"
  have="$(jq -c --arg n "$name" --arg conn "$(jq -r .selectors.connectionId <<<"$want")" \
    '[.[] | select(.name==$n and .selectors.connectionId==$conn)][0] // empty' <<<"$existing")"
  printf '%s' "$want" > "$WORK/p.json"
  if [[ -z "$have" ]]; then
    log "  create: $name"
    (( DRY )) || api POST "/companies/$cid/tools/policies" "$WORK/p.json" >/dev/null
  elif ! jq -e --argjson w "$want" '
      def norm: with_entries(.value |= (if type=="array" then sort else . end));
      (.policyType==$w.policyType) and (.enabled==true) and (.priority==$w.priority)
      and ((.selectors|norm)==($w.selectors|norm)) and (.conditions==$w.conditions)' <<<"$have" >/dev/null; then
    log "  update (drifted): $name"
    (( DRY )) || api PATCH "/companies/$cid/tools/policies/$(jq -r .id <<<"$have")" "$WORK/p.json" >/dev/null
  else
    log "  ok: $name"
  fi
}

# probe CID CONN AGENT LABEL TOOL PARAMS_JSON EXPECTED_DECISION [POLICY_NAME_FOR_A_BLOCK]
# "off" counts only when a policy denied it; "allowed" or "off" for an agent without access is reported, not fatal.
probe() {
  local cid="$1" conn="$2" agent="$3" label="$4" tool="$5" params="$6" want="$7" resp decision ar reason
  jq -n --arg a "$agent" --arg t "$tool" --argjson p "$params" '{agentId:$a, toolName:$t, parameters:$p}' > "$WORK/probe.json"
  resp="$(api POST "/tool-connections/$conn/test-calls" "$WORK/probe.json")"
  decision="$(jq -r '.decision // "none"' <<<"$resp")"
  reason="$(jq -r '.error.reasonCode // empty' <<<"$resp")"
  ar="$(jq -r '.actionRequestId // empty' <<<"$resp")"
  if [[ -n "$ar" ]]; then
    jq -n --arg c "$cid" '{companyId:$c, reason:"connecthub-governance probe; never meant to run"}' > "$WORK/decline.json"
    api POST "/tool-gateway/action-requests/$ar/decline" "$WORK/decline.json" >/dev/null
  fi
  if [[ "$decision" == off && "$reason" != deny_policy_block && "$want" != ask_first ]]; then
    log "  NOT PROVEN: $label (the probe agent has no access to this connection: $reason)"; unproven=$((unproven + 1)); return
  fi
  [[ "$decision" == "$want" && ( "$want" != off || "$reason" == deny_policy_block ) ]] ||
    die "probe '$label' on connection $conn: expected $want, got $decision${reason:+ ($reason)}: $(head -c 300 <<<"$resp")"
  # A block must come from the policy meant to give it (the server returns that policy's description).
  if [[ "$want" == off && -n "${8:-}" ]]; then
    local expect
    expect="$(jq -r --arg n "connect-hub: $8" '.[] | select(.name == $n) | .description' <<<"$desired")"
    [[ "$(jq -r '.error.message // empty' <<<"$resp")" == "$expect" ]] ||
      die "probe '$label': blocked, but not by \"connect-hub: $8\": $(jq -r '.error.message // empty' <<<"$resp")"
  fi
  log "  probe ok: $label -> $decision"
}
exec_args() { jq -cn --arg t "$1" --arg a "${2:-}" '{tool: $t, arguments: (if $a == "" then {} else ($a | fromjson) end)}'; }

# check_catalog CNAME CONN -> "ready" or "held"; dies on a catalog these rules cannot govern.
check_catalog() {
  local cat
  cat="$(api GET "/tool-connections/$2/catalog" | jq -c '(.catalog | if type == "array" then . else (.tools // .entries // []) end)
    | map({name: (.toolName // .name), status: (.status // "active")})')"
  if ! jq -e 'any(.name == "hub_execute_destructive")' >/dev/null <<<"$cat" && (( ! DRY )); then
    api POST "/tool-connections/$2/catalog/refresh" >/dev/null || exit 1 # the hub may have been upgraded since the last listing
    cat="$(api GET "/tool-connections/$2/catalog" | jq -c '(.catalog | if type == "array" then . else (.tools // .entries // []) end)
      | map({name: (.toolName // .name), status: (.status // "active")})')"
  fi
  local direct
  direct="$(jq -c '[.[] | select(.name | contains("__")) | .name][:5]' <<<"$cat")"
  [[ "$direct" == "[]" ]] || die "$1: connection $2 is a direct-mode hub server ($direct ...); these rules govern router mode only. Switch it to router mode"
  jq -e 'any(.name == "hub_execute")' >/dev/null <<<"$cat" || die "$1: connection $2 has no hub_execute; is it a router-mode Connect Hub server?"
  if ! jq -e 'any(.name == "hub_execute_destructive")' >/dev/null <<<"$cat"; then
    local why="connection $2 has no hub_execute_destructive: its hub is too old and runs deletes through hub_execute"
    (( DRY )) && { log "  WARNING: $why (or the catalog is stale; a live run refreshes it first)" >&2; echo held; return; }
    die "$1: $why. Deploy the current hub, then re-run"
  fi
  jq -e 'any(.name == "hub_read")' >/dev/null <<<"$cat" || log "  WARNING: no hub_read on connection $2: C-level agents cannot read other apps" >&2
  if jq -e '[.[] | select(.name == "hub_execute" or .name == "hub_execute_destructive") | .status] | all(. == "active")' >/dev/null <<<"$cat"
  then echo ready; else echo held; fi
}

# An instance admin lists every company but can change only those it is a member of. Report the others.
companies="$(api GET "/companies" | jq 'if type=="array" then . else (.companies // .items) end | [.[] | select((.status // "active") != "archived")]')"
accessible="$(api GET "/companies?scope=accessible" | jq -c 'if type=="array" then . else (.companies // .items) end | [.[].id]')"
jq -r --argjson a "$accessible" --arg only "$ONLY_COMPANY" \
  '.[] | select(($only == "" or .id == $only) and (.id | IN($a[]) | not)) | "[connecthub-governance] NOT APPLIED to \(.name): this key'"'"'s user is not a member"' <<<"$companies"
companies="$(jq --argjson a "$accessible" '[.[] | select(.id | IN($a[]))]' <<<"$companies")"
[[ -z "$ONLY_COMPANY" ]] || companies="$(jq --arg id "$ONLY_COMPANY" '[.[] | select(.id==$id)]' <<<"$companies")"
[[ "$(jq length <<<"$companies")" -gt 0 ]] || die "no matching active company visible to this board key"

total=0; unproven=0; pending=()
for cid in $(jq -r '.[].id' <<<"$companies"); do
  cname="$(jq -r --arg id "$cid" '.[]|select(.id==$id)|.name' <<<"$companies")"
  conns="$(api GET "/companies/$cid/tools/connections" |
    jq '[(.connections // .)[] | select(.status=="active" and ((.config.sourceTemplateKey // .transportConfig.sourceTemplateKey // "") == "connecthub"))]')"
  if [[ "$(jq length <<<"$conns")" -eq 0 ]]; then log "$cname: no active Connect Hub connection, skipped"; continue; fi
  agents="$(api GET "/companies/$cid/agents" | jq '[(if type=="array" then . else .agents end)[] | select(.status != "terminated")]')"
  clevel="$(jq -c '[.[] | select((.role | IN("ceo","cto","cmo","cfo"))
      or ((.title // "") | test("^Chief .*Officer$")) or (.name | test("^C[A-Z]O$"))) | .id]' <<<"$agents")"
  engineers="$(jq -c --argjson c "$clevel" '[.[] | select((.role | ascii_downcase | test("engineer|devops|^qa$")) and (.id | IN($c[]) | not)) | .id]' <<<"$agents")"
  workers="$(jq -c --argjson c "$clevel" --argjson e "$engineers" '[.[] | select((.id | IN($c[])) or (.id | IN($e[])) | not) | .id]' <<<"$agents")"
  names() { jq -r --argjson ids "$1" '[.[] | select(.id | IN($ids[])) | .name] | join(", ")' <<<"$agents"; }
  log "== $cname"
  log "  C-level:     $(names "$clevel")"
  log "  engineering: $(names "$engineers")"
  log "  working:     $(names "$workers")"
  [[ "$(jq length <<<"$clevel")" -gt 0 ]] || log "  WARNING: no C-level agents found; the C-level rules are not applied"
  existing="$(api GET "/companies/$cid/tools/policies" | jq '(.policies // .)')"

  for conn in $(jq -r '.[].id' <<<"$conns"); do
    log "  Connect Hub connection $conn"
    state="$(check_catalog "$cname" "$conn")" || exit 1
    desired="$(desired_policies "$conn" "$clevel" "$engineers" "$workers")"
    while read -r want; do ensure_policy "$cid" "$existing" "$want"; done < <(jq -c '.[]' <<<"$desired")
    # Older versions of this script used other names; disable what this version does not want.
    while read -r old; do
      log "  disable (no longer wanted): $(jq -r .name <<<"$old")"
      (( DRY )) || { printf '{"enabled":false}' > "$WORK/off.json"; api PATCH "/companies/$cid/tools/policies/$(jq -r .id <<<"$old")" "$WORK/off.json" >/dev/null; }
    done < <(jq -c --arg conn "$conn" --argjson want "$(jq '[.[].name]' <<<"$desired")" '.[] | select(.enabled and
      .selectors.connectionId == $conn and (.name | startswith("connect-hub: ")) and (.name | IN($want[]) | not))' <<<"$existing")
    if (( DRY )); then total=$((total + 1)); continue; fi
    if [[ "$state" != ready ]]; then
      pending+=("$cname: review hub_execute and hub_execute_destructive on connection $conn (Paperclip > Apps > Connect Hub > Tools), then re-run to prove the rules")
      total=$((total + 1)); continue
    fi
    cl="$(jq -r '.[0] // empty' <<<"$clevel")"; en="$(jq -r '.[0] // empty' <<<"$engineers")"; wk="$(jq -r '.[0] // empty' <<<"$workers")"
    X=hub_execute; XD=hub_execute_destructive
    if [[ -n "$cl" ]]; then
      probe "$cid" "$conn" "$cl" "C-level writes to Drive"         $X  "$(exec_args google-drive.zz_governance_probe)" allowed
      probe "$cid" "$conn" "$cl" "C-level writes to Docs"          $X  "$(exec_args google-docs.zz_governance_probe)" allowed
      probe "$cid" "$conn" "$cl" "C-level posts to Slack via the hub" $X "$(exec_args slack.zz_governance_probe)" off "C-level agents write only to Google Drive"
      probe "$cid" "$conn" "$cl" "C-level writes to GitHub"        $X  "$(exec_args github.zz_governance_probe)" off "C-level agents write only to Google Drive"
      probe "$cid" "$conn" "$cl" "C-level writes to another app"   $X  "$(exec_args todoist.zz_governance_probe)" off "C-level agents write only to Google Drive"
      probe "$cid" "$conn" "$cl" "C-level deletes in Drive"        $XD "$(exec_args google-drive.zz_governance_probe)" ask_first
    fi
    if [[ -n "$wk" ]]; then
      probe "$cid" "$conn" "$wk" "worker posts to Slack"           $X  "$(exec_args slack.zz_governance_probe)" off "no Slack through the hub"
      probe "$cid" "$conn" "$wk" "worker raw-calls Slack"          $XD "$(exec_args slack.custom_api_call)" off "no Slack through the hub"
      probe "$cid" "$conn" "$wk" "worker posts to Reddit"          $X  "$(exec_args reddit.zz_governance_probe)" off "no Reddit posting"
      probe "$cid" "$conn" "$wk" "worker deletes on Reddit"        $XD "$(exec_args reddit.zz_governance_probe)" off "no Reddit posting"
      probe "$cid" "$conn" "$wk" "worker publishes to LinkedIn"    $X  "$(exec_args linkedin.zz_governance_probe)" ask_first
      probe "$cid" "$conn" "$wk" "worker posts on Google Business" $X  "$(exec_args google-my-business.zz_governance_probe)" ask_first
      probe "$cid" "$conn" "$wk" "worker sends Gmail"              $X  "$(exec_args gmail.zz_governance_probe_send)" ask_first
      probe "$cid" "$conn" "$wk" "worker writes to GitHub"         $X  "$(exec_args github.zz_governance_probe)" off "GitHub writes belong to engineering"
      probe "$cid" "$conn" "$wk" "worker deletes on GitHub"        $XD "$(exec_args github.zz_governance_probe)" off "GitHub writes belong to engineering"
      probe "$cid" "$conn" "$wk" "worker deletes in another app"   $XD "$(exec_args todoist.zz_governance_probe)" ask_first
      probe "$cid" "$conn" "$wk" "worker uses another app"         $X  "$(exec_args todoist.zz_governance_probe)" allowed
      probe "$cid" "$conn" "$wk" "worker connects an app"          hub_connect '{"toolkit":"zz_governance_probe"}' ask_first
    fi
    if [[ -n "$en" ]]; then
      probe "$cid" "$conn" "$en" "engineer writes to GitHub"       $X  "$(exec_args github.zz_governance_probe)" allowed
      probe "$cid" "$conn" "$en" "engineer deletes on GitHub"      $XD "$(exec_args github.zz_governance_probe)" ask_first
      probe "$cid" "$conn" "$en" "engineer posts to Slack"         $X  "$(exec_args slack.zz_governance_probe)" off "no Slack through the hub"
    fi
    total=$((total + 1))
  done
done
[[ "$total" -gt 0 ]] || die "no active Connect Hub connection found in any target company (nothing governed)"
for m in "${pending[@]}"; do log "PENDING: $m"; done
(( unproven == 0 )) || log "PENDING: $unproven probe(s) not proven because the probe agent has no access to the connection"
log "done: $total Connect Hub connection(s) governed$([[ "$DRY" -eq 1 ]] && echo ' (dry run, no writes, no probes)')"
