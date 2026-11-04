#!/usr/bin/env bash
# setup-connecthub-governance.sh — apply the owner's agent rules to every Connect Hub connection, for EVERY
# active company that has one, idempotently. Run with --dry-run first.
#
# Owner's rules (2026-11-04):
#   - C-level agents read everything and write only to Google Drive and Slack (channels, the board). They assign
#     work to their own agents, and to a peer C-level for cross-functional work (e.g. a web page from the CMO or
#     Content Marketer goes to the Sr. Engineer through the CIO).
#   - Working agents write with the tools of their function. Status updates to Slack go through the C-level they
#     report to, never straight to Slack.
#   - Plus the standing rules: repo writes belong to engineering; community posting (Reddit, Stack Exchange) is
#     human-only; publishing to social channels and connecting a new app need the board.
#
# Connect Hub runs every app through hub_execute(tool: "<app>.<action>"), so these are company policies on that
# tool, matched on the app (and, for destructive actions, the action) in the slug. Reads go through hub_read,
# which the hub refuses for any tool it does not mark read-only and Paperclip classifies as a read: no policy
# here touches it, so C-level agents keep reading through the hub under the job-function write block. (hub_read
# needs a hub with the hub_read tool; until then reads also go through hub_execute and are blocked for C-level.)
#
# Per Connect Hub connection (lower priority = evaluated first; the first matching policy decides):
#    9 ask first  hub_connect                                   connecting an app needs the board (everyone)
#    9 ask first  hub_execute, destructive action (delete, remove, destroy, purge, revoke, trash, unpublish,
#                 archive, clear)                                everyone, C-level included
#    9 ask first  hub_execute on <app>.custom_api_call           raw API calls (everyone)
#   10 allow      hub_execute on Google Drive/Docs/Sheets/Slides and Slack            C-level agents
#   12 block      hub_execute, everything else                                        C-level agents
#   20 block      hub_execute on Reddit / Stack Exchange                              community posts are human-only
#   20 block      hub_execute on Slack                          working agents report through their C-level
#   21 ask first  hub_execute on LinkedIn, Facebook, Instagram, YouTube               publishing needs the board
#   21 ask first  hub_execute sending, replying or forwarding Gmail                   external email needs the board
#   22 allow      hub_execute on GitHub                                               engineering agents
#   23 block      hub_execute on GitHub, everyone else          repo writes belong to engineering
# Anything else is allowed for working agents (their function's tools).
#
# C-level and engineering are classified exactly as setup-agent-job-function-access.sh does (role ceo/cto/cmo/cfo,
# a "Chief ... Officer" title or a C?O name; engineering = role engineer/devops/qa). Re-run after each hire: the
# agent lists are explicit. A policy that exists with a different type, priority, selectors or conditions (or
# disabled) is updated in place.
#
# Then it PROVES the rules with gateway test calls, using tool slugs that do not exist on the hub
# ("<app>.zz_governance_probe"), so an allowed call fails at the hub and nothing can change; ask-first requests the
# probes create are declined at once.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API key of an instance admin who is a
# member of the companies (`paperclipai token board create --name connecthub-governance --ttl-days 1`).
# Usage: deploy/scripts/setup-connecthub-governance.sh [--company-id <id>] [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_URL:-https://org.baisoln.com}"
ONLY_COMPANY=""; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --company-id) ONLY_COMPANY="${2:?--company-id needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,46p' "$0"; exit 0 ;;
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

# Slug patterns: "<app>.<action>". Apps are the hub's toolkit slugs.
C_LEVEL_WRITE_APPS='^(google-drive|google-docs|google-sheets|google-slides|slack)\.'
# Destructive verbs as whole words in snake, kebab or camel case (deleteRedditPost); "untrash"/"unarchive" restore.
DESTRUCTIVE='^[a-z0-9-]+\.(.*[_-])?([Dd]elete|[Rr]emove|[Dd]estroy|[Pp]urge|[Rr]evoke|[Tt]rash|[Uu]npublish|[Aa]rchive|[Cc]lear)([_A-Z-].*)?$'
# The raw-API escape hatch can do anything the app's API allows.
RAW_API='^[a-z0-9-]+\.custom_api_call$'
COMMUNITY='^(reddit|stackexchange)\.'
SLACK='^slack\.'
SOCIAL='^(linkedin|facebook-pages|instagram-business|youtube)\.'
# Sends, replies, forwards and approval mails go out; creating a draft (create_draft, create_draft_reply) does not.
EMAIL_SEND='^gmail\.(?!(gmail_)?create_draft)(.*[_-])?(send|reply|forward|request_approval)([_-].*)?$'
GITHUB='^github\.'

# desired_policies CONNECTION CLEVEL_IDS ENGINEER_IDS -> JSON array.
desired_policies() {
  jq -n --arg conn "$1" --argjson c "$2" --argjson e "$3" \
    --arg cw "$C_LEVEL_WRITE_APPS" --arg d "$DESTRUCTIVE" --arg co "$COMMUNITY" --arg sl "$SLACK" \
    --arg so "$SOCIAL" --arg em "$EMAIL_SEND" --arg gh "$GITHUB" --arg raw "$RAW_API" '
    def p($name; $desc; $type; $prio; $tools; $agents; $match):
      { name: ("connect-hub: " + $name), description: $desc, policyType: $type, priority: $prio, enabled: true,
        selectors: ({ toolNames: $tools, connectionId: $conn } + (if $agents then { agentIds: $agents } else {} end)),
        conditions: (if $match then { arguments: { fieldMatches: { tool: $match } } } else null end) };
    [ p("connecting an app needs the board"; "A person connects each app; the board approves first.";
        "require_approval"; 9; ["hub_connect"]; null; null),
      p("destructive actions need the board"; "Deletes and other irreversible actions through the hub need board approval, for every agent.";
        "require_approval"; 9; ["hub_execute"]; null; $d),
      p("raw API calls need the board"; "custom_api_call can do anything the app API allows, so the board approves each one.";
        "require_approval"; 9; ["hub_execute"]; null; $raw),
      p("C-level agents write to Google Drive and Slack"; "Owner: C-level agents read everything and write only to Google Drive and Slack.";
        "allow"; 10; ["hub_execute"]; $c; $cw),
      p("C-level agents do not write elsewhere"; "C-level agents delegate tactical work; they read through hub_read.";
        "block"; 12; ["hub_execute"]; $c; null),
      p("no community posting"; "Owner: replies on Reddit and Stack Exchange are human-posted; agents draft them.";
        "block"; 20; ["hub_execute"]; null; $co),
      p("Slack goes through your C-level"; "Owner: working agents report status through the C-level they report to, not straight to Slack.";
        "block"; 20; ["hub_execute"]; null; $sl),
      p("social publishing needs the board"; "Agents draft; the board publishes to social channels.";
        "require_approval"; 21; ["hub_execute"]; null; $so),
      p("external email needs the board"; "Sending, replying or forwarding email through the hub needs board approval.";
        "require_approval"; 21; ["hub_execute"]; null; $em),
      p("engineering agents write to GitHub"; "Repo writes are the engineering job function.";
        "allow"; 22; ["hub_execute"]; $e; $gh),
      p("GitHub writes belong to engineering"; "Other agents create a task for engineering (through their C-level for cross-functional work).";
        "block"; 23; ["hub_execute"]; null; $gh)
    ]
    # An agent list must never be empty: an empty agentIds selector would match nobody or everybody.
    | map(select(.selectors.agentIds == null or (.selectors.agentIds | length) > 0))'
}

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

# probe CID CONN AGENT LABEL TOOL PARAMS_JSON EXPECTED_DECISION
probe() {
  local cid="$1" conn="$2" agent="$3" label="$4" tool="$5" params="$6" want="$7" resp decision ar
  jq -n --arg a "$agent" --arg t "$tool" --argjson p "$params" '{agentId:$a, toolName:$t, parameters:$p}' > "$WORK/probe.json"
  resp="$(api POST "/tool-connections/$conn/test-calls" "$WORK/probe.json")"
  decision="$(jq -r '.decision // "none"' <<<"$resp")"
  ar="$(jq -r '.actionRequestId // empty' <<<"$resp")"
  if [[ -n "$ar" ]]; then
    jq -n --arg c "$cid" '{companyId:$c, reason:"connecthub-governance probe; never meant to run"}' > "$WORK/decline.json"
    api POST "/tool-gateway/action-requests/$ar/decline" "$WORK/decline.json" >/dev/null
  fi
  [[ "$decision" == "$want" ]] || die "probe '$label' on connection $conn: expected $want, got $decision: $(head -c 300 <<<"$resp")"
  log "  probe ok: $label -> $decision"
}
exec_args() { jq -cn --arg t "$1" '{tool: $t, arguments: {}}'; }

# An instance admin lists every company but can change only those it is a member of. Report the others.
companies="$(api GET "/companies" | jq 'if type=="array" then . else (.companies // .items) end | [.[] | select((.status // "active") != "archived")]')"
accessible="$(api GET "/companies?scope=accessible" | jq -c 'if type=="array" then . else (.companies // .items) end | [.[].id]')"
jq -r --argjson a "$accessible" --arg only "$ONLY_COMPANY" \
  '.[] | select(($only == "" or .id == $only) and (.id | IN($a[]) | not)) | "[connecthub-governance] NOT APPLIED to \(.name): this key'"'"'s user is not a member"' <<<"$companies"
companies="$(jq --argjson a "$accessible" '[.[] | select(.id | IN($a[]))]' <<<"$companies")"
[[ -z "$ONLY_COMPANY" ]] || companies="$(jq --arg id "$ONLY_COMPANY" '[.[] | select(.id==$id)]' <<<"$companies")"
[[ "$(jq length <<<"$companies")" -gt 0 ]] || die "no matching active company visible to this board key"

total=0
for cid in $(jq -r '.[].id' <<<"$companies"); do
  cname="$(jq -r --arg id "$cid" '.[]|select(.id==$id)|.name' <<<"$companies")"
  conns="$(api GET "/companies/$cid/tools/connections" |
    jq '[(.connections // .)[] | select(.status=="active" and ((.config.sourceTemplateKey // "") == "connecthub"))]')"
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
    desired_policies "$conn" "$clevel" "$engineers" | jq -c '.[]' | while read -r want; do ensure_policy "$cid" "$existing" "$want"; done
    if (( DRY )); then total=$((total + 1)); continue; fi
    cl="$(jq -r '.[0] // empty' <<<"$clevel")"; en="$(jq -r '.[0] // empty' <<<"$engineers")"; wk="$(jq -r '.[0] // empty' <<<"$workers")"
    if [[ -n "$cl" ]]; then
      probe "$cid" "$conn" "$cl" "C-level writes to Slack"        hub_execute "$(exec_args slack.zz_governance_probe)" allowed
      probe "$cid" "$conn" "$cl" "C-level writes to Drive"        hub_execute "$(exec_args google-drive.zz_governance_probe)" allowed
      probe "$cid" "$conn" "$cl" "C-level writes to GitHub"       hub_execute "$(exec_args github.zz_governance_probe)" off
      probe "$cid" "$conn" "$cl" "C-level deletes in Drive"       hub_execute "$(exec_args google-drive.zz_governance_probe_delete)" ask_first
    fi
    if [[ -n "$wk" ]]; then
      probe "$cid" "$conn" "$wk" "worker posts to Slack"          hub_execute "$(exec_args slack.zz_governance_probe)" off
      probe "$cid" "$conn" "$wk" "worker posts to Reddit"         hub_execute "$(exec_args reddit.zz_governance_probe)" off
      probe "$cid" "$conn" "$wk" "worker publishes to LinkedIn"   hub_execute "$(exec_args linkedin.zz_governance_probe)" ask_first
      probe "$cid" "$conn" "$wk" "worker sends Gmail"             hub_execute "$(exec_args gmail.zz_governance_probe_send)" ask_first
      probe "$cid" "$conn" "$wk" "worker writes to GitHub"        hub_execute "$(exec_args github.zz_governance_probe)" off
      probe "$cid" "$conn" "$wk" "worker uses another app"        hub_execute "$(exec_args todoist.zz_governance_probe)" allowed
      probe "$cid" "$conn" "$wk" "worker connects an app"         hub_connect '{"toolkit":"zz_governance_probe"}' ask_first
      probe "$cid" "$conn" "$wk" "worker makes a raw API call"    hub_execute "$(exec_args todoist.custom_api_call)" ask_first
    fi
    if [[ -n "$en" ]]; then
      probe "$cid" "$conn" "$en" "engineer writes to GitHub"      hub_execute "$(exec_args github.zz_governance_probe)" allowed
      probe "$cid" "$conn" "$en" "engineer posts to Slack"        hub_execute "$(exec_args slack.zz_governance_probe)" off
    fi
    total=$((total + 1))
  done
done
[[ "$total" -gt 0 ]] || die "no active Connect Hub connection found in any target company (nothing governed)"
log "done: $total Connect Hub connection(s) governed$([[ "$DRY" -eq 1 ]] && echo ' (dry run, no writes, no probes)')"
