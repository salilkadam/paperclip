#!/usr/bin/env bash
# setup-board-cards.sh — make one private Slack channel per company the board channel, where
# every pending board decision (approvals, tool-action confirmations, agent questions) is posted.
# Plan: doc/plans/2026-11-02-board-channel-cards.md
#
# Usage:
#   PAPERCLIP_BOARD_KEY_FILE=~/.pc-board-key bash deploy/scripts/setup-board-cards.sh \
#     [--assign ceoreliora=#reliora-board] [--assign ceobionic=#bionic-board] [--dry-run]
#
# Defaults (when no --assign is given): ceoreliora=#reliora-board, ceobionic=#bionic-board.
# For each pair: finds the bot's live Slack connection, the channel resource (by id or label),
# requires it to be enabled, sets it as the company's board channel (the server refuses a
# public, shared or DM channel, and a second board channel per company), reads it back, and
# lists the principals linked on that bot so the owner can see whether their Slack user is
# linked there (needed for Slack buttons in stage 2).
#
# Requires: curl, jq. Prints no secret values.
set -euo pipefail

API="${PAPERCLIP_API_URL:-https://org.baisoln.com}"
DRY=0
ASSIGN=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --assign) ASSIGN+=("$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ ${#ASSIGN[@]} -gt 0 ]] || ASSIGN=("ceoreliora=#reliora-board" "ceobionic=#bionic-board")

die() { echo "FAIL: $*" >&2; exit 1; }
log() { echo "$*"; }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -n "${PAPERCLIP_BOARD_KEY_FILE:-}" && -s "$PAPERCLIP_BOARD_KEY_FILE" ]] || die "set PAPERCLIP_BOARD_KEY_FILE to a 0600 file holding a board API key"

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"
call() {
  CODE="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" -H 'Content-Type: application/json' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
}
api() { call "$@"; [[ "$CODE" =~ ^2 ]] || die "$1 $2 -> HTTP $CODE: $(head -c 400 "$WORK/resp")"; cat "$WORK/resp"; }

companies="$(api GET /companies)"
jq -e 'type=="array"' <<<"$companies" >/dev/null || companies="$(jq '.companies // .items' <<<"$companies")"
endpoints='[]'
for cid in $(jq -r '.[] | select((.status // "active") != "archived") | .id' <<<"$companies"); do
  page="$(api GET "/companies/$cid/chat-endpoints" | jq 'if type=="array" then . else .endpoints end')"
  endpoints="$(jq -s '.[0] + [.[1][] | select(.provider=="slack" and (.status|IN("archived","revoked")|not))]' <<<"$endpoints $page")"
done

for a in "${ASSIGN[@]}"; do
  bot="${a%%=*}"; channel="${a#*=}"
  matches="$(jq --arg b "$bot" '[.[] | select((.botUsername // .botLabel // "" | ltrimstr("@")) == $b)]' <<<"$endpoints")"
  [[ "$(jq length <<<"$matches")" -eq 1 ]] || die "$bot: expected exactly one live Slack connection, found $(jq length <<<"$matches")"
  ep="$(jq -r '.[0].id' <<<"$matches")"; cid="$(jq -r '.[0].companyId' <<<"$matches")"
  resources="$(api GET "/chat-endpoints/$ep/resources")"
  res="$(jq -c --arg c "$channel" '[.[] | select(.type=="channel" and (.providerResourceId==$c or .label==$c or ("#"+.label)==$c))]' <<<"$resources")"
  [[ "$(jq length <<<"$res")" -eq 1 ]] || die "$bot: channel $channel not found exactly once on connection $ep (invite the bot first)"
  rid="$(jq -r '.[0].id' <<<"$res")"
  [[ "$(jq -r '.[0].enabled' <<<"$res")" == true ]] || die "$bot: $channel is not enabled on the connection; enable it in Settings first"
  log "$bot ($ep, company $cid): $channel = resource $rid"
  if [[ "$(jq -r '.[0].boardCards // false' <<<"$res")" == true ]]; then
    log "  ok: already the board channel"
  elif [[ "$DRY" -eq 1 ]]; then
    log "  would set it as the board channel"
  else
    jq -nc --arg r "$rid" '{boardCards:{resourceId:$r, enabled:true}}' > "$WORK/patch.json"
    api PATCH "/chat-endpoints/$ep" "$WORK/patch.json" >/dev/null
    api GET "/chat-endpoints/$ep/resources" | jq -e --arg r "$rid" '.[] | select(.id==$r) | .boardCards == true' >/dev/null \
      || die "$bot: board channel did not read back"
    log "  set: board channel (cards appear within about 20 seconds)"
  fi
  principals="$(api GET "/chat-endpoints/$ep/principals" 2>/dev/null || echo '[]')"
  log "  people linked on this bot (needed to use Slack buttons later):"
  jq -r '(if type=="array" then . else (.principals // []) end)[] | select(.link.status? == "linked" or .status? == "linked") | "    - \(.displayName // .externalId) -> \(.link.paperclipUserId // .paperclipUserId // "?")"' <<<"$principals" || true
done
log "OK$([[ "$DRY" -eq 1 ]] && echo " (dry run: nothing written)")"
