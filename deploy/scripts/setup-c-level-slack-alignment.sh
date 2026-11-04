#!/usr/bin/env bash
# setup-c-level-slack-alignment.sh — Option B: the CEO bot is the sole board
# channel voice; every other C-level Slack bot is @mention-only; DMs stay open.
# Plan: doc/plans/2026-11-04-c-level-slack-alignment.md
#
# Why (verified against server/src/services/chat-channels/inbound/):
#   - requireAtMention=false makes every top-level human post in an enabled
#     channel wake the bound agent (admission.ts), so several C-level bots
#     with mention=false in one board channel means every board post wakes
#     every C-level agent.
#   - Board channel trust requires requireAtMention=false, so exactly one
#     bot — the CEO's — keeps mention=false and is board-trusted (and its
#     externalExecutionPolicy is agent). Every other C-level bot must be
#     @mention-only. Direct messages still reach every bot either way:
#     isDM bypasses the mention requirement.
#
# For every active company visible to the board key this script:
#   1. classifies C-level agents — same classifier as
#      setup-agent-job-function-access.sh: role ceo/cto/cmo/cfo, a
#      "Chief * Officer" title, or a name like CIO/CLO/COO;
#   2. finds the company's board channel: the channel resource flagged
#      boardCards (at most one per company by database constraint);
#   3. CEO endpoint: ASSERTS ONLY (warn, never edit) that it still has
#      requireAtMention=false, externalExecutionPolicy=agent and the board
#      channel enabled+trusted+cards; setup-board-channel-trust.sh owns it;
#   4. non-CEO C-level endpoints with the board channel enabled: enforces
#      requireAtMention=true via PATCH and proves it with a GET read-back;
#   5. non-CEO C-level endpoints missing the board channel: prints the
#      human step `/invite @bot #board` — a Slack bot cannot join a public
#      channel itself and Paperclip auto-enables a channel when the bot
#      joins, so no API call can replace the invite;
#   6. C-level agents with no active Slack endpoint: reports the gap and the
#      POST /api/chat-endpoints shape (creating the endpoint needs a Slack
#      app a human made first — reported only, never written).
#
# Idempotent: a second run changes nothing and re-proves the end state.
# Never touches non-C-level agents, draft endpoints, or non-Slack providers.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board
# API key with connection-management rights (never on a command line).
# PAPERCLIP_API_BASE overrides the API origin.
#
# Usage: deploy/scripts/setup-c-level-slack-alignment.sh [--company-id UUID] [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
ONLY_COMPANY=""
DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --company-id) ONLY_COMPANY="${2:?--company-id needs a UUID}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,43p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[c-level-slack] $*"; }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"

# call METHOD PATH [json-file] -> sets CODE, body in $WORK/resp. Transport errors are fatal.
call() {
  CODE="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-c-level-slack-alignment/1' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
}
# api METHOD PATH [json-file] -> body on stdout; non-2xx is fatal with the body.
api() {
  call "$@"
  [[ "$CODE" =~ ^2 ]] || die "$1 $2 -> HTTP $CODE: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}
patch_endpoint() { printf '%s' "$2" > "$WORK/patch.json"; api PATCH "/chat-endpoints/$1" "$WORK/patch.json" >/dev/null; }

: > "$WORK/humans"
note_human() { echo "$*" >> "$WORK/humans"; }

# An instance admin lists every company but can change only those it is a
# member of. Report the others: a skipped company must not look finished.
companies="$(api GET "/companies" | jq 'if type=="array" then . else (.companies // .items) end | [.[] | select((.status // "active") != "archived")]')"
accessible="$(api GET "/companies?scope=accessible" | jq -c 'if type=="array" then . else (.companies // .items) end | [.[].id]')"
while read -r skipped; do
  [[ -z "$skipped" ]] || log "NOT touched, company '$skipped': this key's user is not a member of it"
done < <(jq -r --argjson a "$accessible" '.[] | select((.id | IN($a[]) | not)) | .name' <<<"$companies")
companies="$(jq --argjson a "$accessible" '[.[] | select(.id | IN($a[]))]' <<<"$companies")"
[[ -z "$ONLY_COMPANY" ]] || companies="$(jq --arg id "$ONLY_COMPANY" '[.[] | select(.id==$id)]' <<<"$companies")"
[[ "$(jq length <<<"$companies")" -gt 0 ]] || die "no matching active company visible to this board key"

while read -r cid; do
  cname="$(jq -r --arg id "$cid" '.[]|select(.id==$id)|.name' <<<"$companies")"
  log "== $cname"
  agents="$(api GET "/companies/$cid/agents" | jq '[.[] | select(.status != "terminated")]')"
  # Verbatim classifier from setup-agent-job-function-access.sh — do not "fix" it.
  clevel="$(jq -c '[.[] | select((.role | IN("ceo","cto","cmo","cfo"))
      or ((.title // "") | test("^Chief .*Officer$")) or (.name | test("^C[A-Z]O$")))]' <<<"$agents")"
  ceo_id="$(jq -r '[.[] | select(.role=="ceo")] | .[0].id // empty' <<<"$agents")"
  [[ -n "$ceo_id" ]] || { log "  no role==ceo agent; CEO-side checks skipped for this company"; }
  endpoints="$(api GET "/companies/$cid/chat-endpoints" \
    | jq 'if type=="array" then . else (.chatEndpoints // .endpoints // .items // []) end
        | [.[] | select(.provider=="slack" and .status=="active")]')"

  # Read every active Slack endpoint's resources once, keyed by endpoint id.
  shopt -s nullglob
  : > "$WORK/resfiles"; rm -f "$WORK"/res-*.json
  for ep in $(jq -r '.[].id' <<<"$endpoints"); do
    api GET "/chat-endpoints/$ep/resources" | jq 'if type=="array" then . else (.resources // .items // []) end' > "$WORK/res-$ep.json"
    echo "$ep" >> "$WORK/resfiles"
  done
  shopt -u nullglob

  # The board channel is the one resource flagged boardCards (DB: one per company).
  board="$(cat "$WORK"/res-*.json 2>/dev/null | jq -sc '[.[][] | select(.boardCards==true)] | if length==0 then null else .[0] end')"
  if [[ "$board" == "null" ]]; then
    log "  no board channel (no resource with boardCards=true): run setup-board-channel-trust.sh first; nothing to align here"
    continue
  fi
  board_rid="$(jq -r .providerResourceId <<<"$board")"
  # The trusted resource's own label can be the bare channel id; prefer a
  # #name seen on any other endpoint's resource for the same channel.
  board_label="$(cat "$WORK"/res-*.json 2>/dev/null | jq -rsc --arg r "$board_rid" \
    '[.[][] | select(.providerResourceId==$r) | .label // empty]
     | (map(select(startswith("#")))[0] // ("#" + $r))')"
  log "  board channel: $board_label ($board_rid)"

  # --- CEO endpoint: assert-only, the trust script owns this state. ---
  while read -r ep; do
    [[ -z "$ep" ]] && continue
    username="$(jq -r --arg e "$ep" '.[]|select(.id==$e)|.botUsername // .botLabel // "bot"' <<<"$endpoints")"
    men="$(jq -r --arg e "$ep" '.[]|select(.id==$e)|.requireAtMention' <<<"$endpoints")"
    pol="$(jq -r --arg e "$ep" '.[]|select(.id==$e)|.externalExecutionPolicy' <<<"$endpoints")"
    ok=1
    [[ "$men" == "false" && "$pol" == "agent" ]] || ok=0
    jq -e --arg r "$board_rid" '[.[] | select(.providerResourceId==$r) | select(.enabled==true and .boardTrusted==true and .boardCards==true)] | length==1' \
      "$WORK/res-$ep.json" >/dev/null || ok=0
    if (( ok )); then
      log "  CEO ($username): mention=false, policy=agent, board trusted+cards — as designed, not touched"
    else
      log "  WARN CEO ($username): state off-contract (mention=$men policy=$pol, or board trust/cards missing). Re-run setup-board-channel-trust.sh; this script will NOT edit CEO settings"
    fi
  done < <(jq -r --arg c "$ceo_id" '.[] | select(.assignedAgentId==$c) | .id' <<<"$endpoints")

  # --- Non-CEO C-level agents. ---
  while read -r agent; do
    [[ -z "$agent" ]] && continue
    aid="$(jq -r .id <<<"$agent")"; aname="$(jq -r .name <<<"$agent")"
    [[ "$aid" == "$ceo_id" ]] && continue
    eps="$(jq -c --arg a "$aid" '[.[] | select(.assignedAgentId==$a)]' <<<"$endpoints")"
    if [[ "$(jq length <<<"$eps")" -eq 0 ]]; then
      log "  $aname: no active Slack endpoint. To give it a voice, a human must first create a Slack app, then POST /api/chat-endpoints:"
      log "    {\"provider\":\"slack\",\"assignedAgentId\":\"$aid\",\"slackSetupMethod\":\"manual\", ...} (see doc/connections/CONNECTOR-PLAYBOOK.md)"
      note_human "  [$cname] $aname has no Slack bot: create a Slack app + endpoint, then /invite @<bot> $board_label"
      continue
    fi
    while read -r ep; do
      [[ -z "$ep" ]] && continue
      username="$(jq -r --arg e "$ep" '.[]|select(.id==$e)|.botUsername // .botLabel // "bot"' <<<"$endpoints")"
      men="$(jq -r --arg e "$ep" '.[]|select(.id==$e)|.requireAtMention' <<<"$endpoints")"
      nres="$(jq 'length' "$WORK/res-$ep.json")"
      on_board="$(jq -c --arg r "$board_rid" '[.[] | select(.providerResourceId==$r)][0] // empty' "$WORK/res-$ep.json")"
      if [[ -n "$on_board" ]] && [[ "$(jq -r '.boardTrusted // false' <<<"$on_board")" == "true" ]]; then
        log "  WARN $aname ($username): a non-CEO endpoint holds board trust — unexpected; not touched. Review before next board post"
        continue
      fi
      if [[ -z "$on_board" ]]; then
        step="/invite @${username} ${board_label} (Slack)"
        log "  $aname ($username): not on $board_label yet ($nres channel resource(s) attached). Human step: $step — the channel auto-enables on join"
        note_human "  [$cname] $step, then re-run this script to prove @mention-only"
        # Still flip the policy so the moment it joins, it is mention-gated.
        if [[ "$men" == "true" ]]; then
          log "    policy already @mention-only"
        elif (( DRY )); then
          log "    DRY-RUN would PATCH $username requireAtMention false -> true"
        else
          patch_endpoint "$ep" '{"requireAtMention":true}'
          jq -e '.requireAtMention == true' <<<"$(api GET "/chat-endpoints/$ep")" >/dev/null \
            || die "$aname ($username): read-back after PATCH did not show requireAtMention=true"
          log "    PATCHED + verified: requireAtMention=true (takes effect when it joins)"
        fi
        continue
      fi
      if [[ "$(jq -r '.enabled' <<<"$on_board")" != "true" ]]; then
        log "  $aname ($username): on $board_label but disabled — left alone; re-enable or remove deliberately"
        continue
      fi
      if [[ "$men" == "true" ]]; then
        log "  $aname ($username) on $board_label: already @mention-only"
      elif (( DRY )); then
        log "  $aname ($username) on $board_label: DRY-RUN would PATCH requireAtMention false -> true"
      else
        patch_endpoint "$ep" '{"requireAtMention":true}'
        jq -e '.requireAtMention == true' <<<"$(api GET "/chat-endpoints/$ep")" >/dev/null \
          || die "$aname ($username): read-back after PATCH did not show requireAtMention=true"
        log "  $aname ($username) on $board_label: PATCHED + read-back verified requireAtMention=true"
      fi
    done < <(jq -r '.[].id' <<<"$eps")
  done < <(jq -c '.[]' <<<"$clevel")
done < <(jq -r '.[].id' <<<"$companies")

if [[ -s "$WORK/humans" ]]; then
  log "Human steps needed (no API can do these):"
  cat "$WORK/humans"
else
  log "No human steps outstanding."
fi
(( DRY )) && log "DRY-RUN: nothing was written." || log "Done."
