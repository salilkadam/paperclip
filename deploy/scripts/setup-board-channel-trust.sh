#!/usr/bin/env bash
# setup-board-channel-trust.sh — make each company's board channel a
# board-trusted channel on exactly one Slack bot, idempotently, and prove it.
# Plan: doc/plans/2026-10-31-board-channel-trust.md (Change 1, rollout).
#
# For every assignment BOT=CHANNEL (default: ceoreliora=#reliora-board and
# ceobionic=#bionic-board; CHANNEL is a Slack channel id like C0123ABCD or a
# #name) it finds the one live Slack connection whose bot username is BOT, in
# whichever active company owns it, and ensures on that connection:
#   - the channel's board trust is ON (the server re-reads Slack and refuses a
#     public, Slack Connect or DM channel, or one another bot already trusts);
#   - externalExecutionPolicy = agent (lifts the restriction for board-trusted
#     conversations only);
#   - requireAtMention = false (trust never overrides a mention requirement);
#   - allowUnlinkedPeople = false (unlinked Slack users never command agents).
# Then it ASSERTS the end state: those four values, the channel still enabled,
# and exactly one resource across all of the company's Slack connections
# trusting that channel id. Other bots in the channel stay @mention-only.
#
# Then it PROVES refusals with the server's read-only board-trust dry run
# (POST /chat-endpoints/:id/board-trust/evaluate; nothing is posted or stored):
#   - a top-level post carrying bot_id   -> must NOT be trusted;
#   - a top-level post carrying app_id   -> must NOT be trusted (user-token apps);
#   - a thread reply (thread_ts != ts)   -> must NOT be trusted;
#   - with --owner-slack-user U…, a plain post by that linked owner/admin must
#     BE trusted (positive control);
# and, when another live Slack connection of the company also sees the channel,
# that trying to trust it there is refused with HTTP 409.
# Any other outcome is fatal.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key with connection-management rights in the target companies
# (`paperclipai token board create --name board-trust --ttl-days 1`). The key
# never appears on a command line. PAPERCLIP_API_BASE overrides the API origin.
#
# Usage: deploy/scripts/setup-board-channel-trust.sh [--assign BOT=CHANNEL]...
#          [--owner-slack-user U…] [--dry-run]
#   BOARD_TRUST_ASSIGNMENTS="bot=#chan other=C123" is read when no --assign is given.
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
ASSIGN=(); OWNER_SLACK_USER=""; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --assign) ASSIGN+=("${2:?--assign needs BOT=CHANNEL}"); shift 2 ;;
    --owner-slack-user) OWNER_SLACK_USER="${2:?--owner-slack-user needs a Slack user id}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ ${#ASSIGN[@]} -eq 0 ]]; then
  read -r -a ASSIGN <<<"${BOARD_TRUST_ASSIGNMENTS:-ceoreliora=#reliora-board ceobionic=#bionic-board}"
fi

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[board-channel-trust] $*"; }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"
[[ -z "$OWNER_SLACK_USER" || "$OWNER_SLACK_USER" =~ ^[UW][A-Z0-9]+$ ]] || die "--owner-slack-user must be a Slack user id"
for a in "${ASSIGN[@]}"; do [[ "$a" =~ ^[A-Za-z0-9._-]+=(#[a-z0-9._-]+|[CG][A-Z0-9]+)$ ]] || die "bad assignment '$a' (want BOT=#channel or BOT=C…)"; done

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"

# call METHOD PATH [json-file] -> sets CODE, body in $WORK/resp. Transport errors are fatal.
call() {
  CODE="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-board-channel-trust/1' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
}
# api METHOD PATH [json-file] -> body on stdout; non-2xx is fatal with the body.
api() {
  call "$@"
  [[ "$CODE" =~ ^2 ]] || die "$1 $2 -> HTTP $CODE: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}
patch_endpoint() { printf '%s' "$2" > "$WORK/patch.json"; api PATCH "/chat-endpoints/$1" "$WORK/patch.json" >/dev/null; }

# evaluate EP RESOURCE USER EVENT_JSON WANT(true|false) LABEL
evaluate() {
  jq -n --arg r "$2" --arg u "$3" --argjson e "$4" '{resourceId:$r, slackUserId:$u, event:$e}' > "$WORK/eval.json"
  local resp got
  resp="$(api POST "/chat-endpoints/$1/board-trust/evaluate" "$WORK/eval.json")"
  got="$(jq -r '.trusted' <<<"$resp")"
  [[ "$got" == "$5" ]] || die "probe '$6' on endpoint $1: expected trusted=$5, got $got: $(head -c 300 <<<"$resp")"
  log "  probe ok: $6 -> trusted=$got"
}

companies="$(api GET /companies)"
jq -e 'type=="array"' <<<"$companies" >/dev/null || companies="$(jq '.companies // .items' <<<"$companies")"
companies="$(jq '[.[] | select((.status // "active") != "archived")]' <<<"$companies")"
[[ "$(jq length <<<"$companies")" -gt 0 ]] || die "no active company visible to this board key"

# All live Slack endpoints across visible companies, once.
endpoints='[]'
for cid in $(jq -r '.[].id' <<<"$companies"); do
  page="$(api GET "/companies/$cid/chat-endpoints" | jq '(.endpoints // .)')"
  endpoints="$(jq -s '.[0] + [.[1][] | select(.provider=="slack" and (.status|IN("archived","revoked")|not))]' <<<"$endpoints $page")"
done

done_count=0
for a in "${ASSIGN[@]}"; do
  bot="${a%%=*}"; channel="${a#*=}"
  matches="$(jq --arg b "$bot" '[.[] | select((.botUsername // "" | ltrimstr("@")) == $b)]' <<<"$endpoints")"
  [[ "$(jq length <<<"$matches")" -eq 1 ]] || die "$bot: expected exactly one live Slack connection, found $(jq length <<<"$matches")"
  ep="$(jq -r '.[0].id' <<<"$matches")"; cid="$(jq -r '.[0].companyId' <<<"$matches")"
  [[ "$(jq -r '.[0].status' <<<"$matches")" == active ]] || die "$bot: connection $ep is not active (board trust requires an active connection)"
  resources="$(api GET "/chat-endpoints/$ep/resources")"
  res="$(jq -c --arg c "$channel" '[.[] | select(.type=="channel" and (.providerResourceId==$c or .label==$c))]' <<<"$resources")"
  [[ "$(jq length <<<"$res")" -eq 1 ]] || die "$bot: channel $channel not found exactly once on connection $ep (invite the bot first)"
  rid="$(jq -r '.[0].id' <<<"$res")"; chan_id="$(jq -r '.[0].providerResourceId' <<<"$res")"
  log "$bot ($ep, company $cid): board channel $channel = $chan_id"
  [[ "$(jq -r '.[0].enabled' <<<"$res")" == true ]] || die "$bot: $channel is not enabled on the connection; enable it in Settings first"

  ep_now="$(api GET "/chat-endpoints/$ep")"
  want='{"requireAtMention":false,"allowUnlinkedPeople":false,"externalExecutionPolicy":"agent"}'
  if jq -e --argjson w "$want" '.requireAtMention==$w.requireAtMention and .allowUnlinkedPeople==$w.allowUnlinkedPeople and .externalExecutionPolicy==$w.externalExecutionPolicy' <<<"$ep_now" >/dev/null; then
    log "  ok: endpoint settings"
  else
    log "  update: requireAtMention=false allowUnlinkedPeople=false externalExecutionPolicy=agent"
    [[ "$DRY" -eq 1 ]] || patch_endpoint "$ep" "$want"
  fi
  if [[ "$(jq -r '.[0].boardTrusted // false' <<<"$res")" == true ]]; then
    log "  ok: $channel is board-trusted"
  else
    log "  update: trust $channel"
    [[ "$DRY" -eq 1 ]] || patch_endpoint "$ep" "$(jq -nc --arg r "$rid" '{boardChannelTrust:{resourceId:$r, trusted:true}}')"
  fi
  [[ "$DRY" -eq 1 ]] && { done_count=$((done_count + 1)); continue; }

  # Assert the end state from fresh reads.
  ep_now="$(api GET "/chat-endpoints/$ep")"
  jq -e --argjson w "$want" '.requireAtMention==$w.requireAtMention and .allowUnlinkedPeople==$w.allowUnlinkedPeople and .externalExecutionPolicy==$w.externalExecutionPolicy and .status=="active"' <<<"$ep_now" >/dev/null \
    || die "$bot: endpoint settings did not stick: $(jq -c '{status,requireAtMention,allowUnlinkedPeople,externalExecutionPolicy}' <<<"$ep_now")"
  trusted_count=0; others=()
  for other in $(jq -r --arg c "$cid" '.[] | select(.companyId==$c) | .id' <<<"$endpoints"); do
    o_res="$(api GET "/chat-endpoints/$other/resources" | jq -c --arg id "$chan_id" '[.[] | select(.providerResourceId==$id)]')"
    n="$(jq '[.[] | select(.boardTrusted==true)] | length' <<<"$o_res")"
    trusted_count=$((trusted_count + n))
    if [[ "$other" == "$ep" ]]; then
      [[ "$(jq -r '.[0].boardTrusted' <<<"$o_res")" == true && "$(jq -r '.[0].enabled' <<<"$o_res")" == true ]] || die "$bot: $channel is not trusted and enabled after setup"
    elif [[ "$(jq length <<<"$o_res")" -gt 0 ]]; then
      others+=("$other:$(jq -r '.[0].id' <<<"$o_res")")
    fi
  done
  [[ "$trusted_count" -eq 1 ]] || die "$bot: $trusted_count resources trust $chan_id in company $cid (want exactly 1)"
  log "  assert ok: one trusted bot for $channel, agent policy, no mention requirement, linked people only"

  # Prove refusals with the dry run (nothing is posted or stored).
  ts="1700000000.000100"; probe_user="${OWNER_SLACK_USER:-U00000000}"
  evaluate "$ep" "$rid" "$probe_user" "{\"type\":\"message\",\"ts\":\"$ts\",\"user\":\"$probe_user\",\"text\":\"probe\",\"bot_id\":\"B00000000\"}" false "bot-authored post"
  evaluate "$ep" "$rid" "$probe_user" "{\"type\":\"message\",\"ts\":\"$ts\",\"user\":\"$probe_user\",\"text\":\"probe\",\"app_id\":\"A00000000\"}" false "app-authored post"
  evaluate "$ep" "$rid" "$probe_user" "{\"type\":\"message\",\"ts\":\"$ts\",\"thread_ts\":\"1700000000.000001\",\"user\":\"$probe_user\",\"text\":\"probe\"}" false "thread reply"
  if [[ -n "$OWNER_SLACK_USER" ]]; then
    evaluate "$ep" "$rid" "$OWNER_SLACK_USER" "{\"type\":\"message\",\"ts\":\"$ts\",\"user\":\"$OWNER_SLACK_USER\",\"text\":\"probe\"}" true "linked owner plain post"
  fi
  for pair in "${others[@]}"; do
    o_ep="${pair%%:*}"; o_rid="${pair#*:}"
    jq -nc --arg r "$o_rid" '{boardChannelTrust:{resourceId:$r, trusted:true}}' > "$WORK/second.json"
    call PATCH "/chat-endpoints/$o_ep" "$WORK/second.json"
    if [[ "$CODE" != 409 ]]; then
      # Never leave a second trusted bot behind if the refusal failed.
      jq -nc --arg r "$o_rid" '{boardChannelTrust:{resourceId:$r, trusted:false}}' > "$WORK/undo.json"
      call PATCH "/chat-endpoints/$o_ep" "$WORK/undo.json"
      die "probe 'second trusted bot' on endpoint $o_ep: expected HTTP 409, got $CODE: $(head -c 300 "$WORK/resp")"
    fi
    log "  probe ok: second trusted bot on $o_ep -> 409"
  done
  done_count=$((done_count + 1))
done
[[ "$done_count" -gt 0 ]] || die "no board channel configured"
log "done: $done_count board channel(s)$([[ "$DRY" -eq 1 ]] && echo ' (dry run, no writes, no probes)')"
