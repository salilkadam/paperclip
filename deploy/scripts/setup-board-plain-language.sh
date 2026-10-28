#!/usr/bin/env bash
# setup-board-plain-language.sh — every agent that can talk to the board carries
# the board-plain-language skill, in every active company, idempotently.
#
# Owner's request (2026-10-28): approvals and anything the board reads are
# written in plain, simple language: the question first, what yes and no each
# do, no ids or tool names in the main text. The bundled skill
# skills/board-plain-language says how; the core paperclip skill points to it.
# This script makes it a desired skill of each agent (mode "add": every other
# skill stays) and checks it resolved. Agents whose adapter has no skill support
# are listed, not failed.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key of an instance admin. The key never appears on a command line.
# The server image must bundle skills/board-plain-language.
#
# Usage: deploy/scripts/setup-board-plain-language.sh [--company-id <id>] [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
SKILL="paperclipai/paperclip/board-plain-language"
ONLY_COMPANY=""; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --company-id) ONLY_COMPANY="${2:?--company-id needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[board-plain-language] $*"; }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"

api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-board-plain-language/1' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}
resolved() { jq -e --arg k "$SKILL" '[.entries[]? | select(.key == $k and .desired
  and (.state == "installed" or .state == "configured" or .state == "available"))] | length == 1' >/dev/null; }

companies="$(api GET /companies)"
jq -e 'type=="array"' <<<"$companies" >/dev/null || companies="$(jq '.companies // .items' <<<"$companies")"
companies="$(jq '[.[] | select((.status // "active") != "archived")]' <<<"$companies")"
[[ -z "$ONLY_COMPANY" ]] || companies="$(jq --arg id "$ONLY_COMPANY" '[.[] | select(.id==$id)]' <<<"$companies")"
[[ "$(jq length <<<"$companies")" -gt 0 ]] || die "no matching active company visible to this board key"

jq -n --arg k "$SKILL" '{mode: "add", desiredSkills: [$k]}' > "$WORK/add.json"
done_n=0; skipped=()
for cid in $(jq -r '.[].id' <<<"$companies"); do
  cname="$(jq -r --arg id "$cid" '.[]|select(.id==$id)|.name' <<<"$companies")"
  agents="$(api GET "/companies/$cid/agents" | jq -c '[.[] | select(.status != "terminated" and .status != "archived") | {id, name}]')"
  while read -r agent; do
    aid="$(jq -r .id <<<"$agent")"; aname="$(jq -r .name <<<"$agent")"
    state="$(api GET "/agents/$aid/skills")"
    if [[ "$(jq -r '.supported' <<<"$state")" != true ]]; then
      skipped+=("$cname/$aname ($(jq -r .adapterType <<<"$state"))"); continue
    fi
    if resolved <<<"$state"; then log "$cname / $aname: ok"; done_n=$((done_n + 1)); continue; fi
    if (( DRY )); then log "$cname / $aname: DRY-RUN would add $SKILL"; continue; fi
    api POST "/agents/$aid/skills/sync" "$WORK/add.json" | resolved \
      || die "$cname / $aname: $SKILL is not desired and resolved after sync (is the server image new enough to bundle it?)"
    log "$cname / $aname: added"; done_n=$((done_n + 1))
  done < <(jq -c '.[]' <<<"$agents")
done
for s in "${skipped[@]}"; do log "no skill support, skipped: $s"; done
(( DRY )) || [[ "$done_n" -gt 0 ]] || die "no agent carries $SKILL (nothing applied)"
log "done: $done_n agent(s) carry $SKILL$([[ "$DRY" -eq 1 ]] && echo ' (dry run)')"
