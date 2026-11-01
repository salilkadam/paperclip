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
# (POST /chat-endpoints/:id/board-trust/evaluate; nothing is posted or stored),
# each asserting trusted=false AND the specific rule that refuses it:
#   - a top-level post carrying bot_id      -> plainHumanTopLevel=false;
#   - a top-level post carrying app_id      -> plainHumanTopLevel=false (user-token apps);
#   - a top-level post without client_msg_id -> plainHumanTopLevel=false (API posts);
#   - a thread reply (thread_ts != ts)      -> plainHumanTopLevel=false;
#   - a plain post (with client_msg_id) by the owner's real Slack user id must
#     BE trusted (mandatory positive control: --owner-slack-user is required);
# and, when another live Slack connection of the company also sees the channel,
# that trying to trust it there is refused with HTTP 409.
#
# --probe-delivery [BOT=]<deliveryId> (repeatable): a delivery the operator
# produced by posting in the channel through a user-token integration (the
# claude.ai Slack connector, Composio, an agent's Slack tool). It is evaluated
# from the verdicts stored at ingress BEFORE any write, also in --dry-run, and
# must come back trusted=false AND rules.plainHuman=false; otherwise nothing is
# changed. Run it once after deploy with trust still off. The delivery id is in
# the connection's activity feed, whose detail also shows the two verdicts
# ("plain human post: yes|no; top-level: yes|no").
# Any other outcome is fatal.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key with connection-management rights in the target companies
# (`paperclipai token board create --name board-trust --ttl-days 1`). The key
# never appears on a command line. PAPERCLIP_API_BASE overrides the API origin.
#
# Usage: deploy/scripts/setup-board-channel-trust.sh [--assign BOT=CHANNEL]...
#          --owner-slack-user [BOT=]U… [--owner-slack-user BOT=U…]...
#          [--probe-delivery [BOT=]<deliveryId>]... [--dry-run]
#   BOARD_TRUST_ASSIGNMENTS="bot=#chan other=C123" is read when no --assign is given.
#   A bare U… (or bare deliveryId) applies to every assignment; BOT=… to one bot
#   (each Slack workspace has its own user ids). Every assignment needs an owner.
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
ASSIGN=(); OWNERS=(); PROBES=(); DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --assign) ASSIGN+=("${2:?--assign needs BOT=CHANNEL}"); shift 2 ;;
    --owner-slack-user) OWNERS+=("${2:?--owner-slack-user needs a Slack user id}"); shift 2 ;;
    --probe-delivery) PROBES+=("${2:?--probe-delivery needs a delivery id}"); shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,56p' "$0"; exit 0 ;;
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
[[ ${#OWNERS[@]} -gt 0 ]] || die "--owner-slack-user is required (the positive-control probe is mandatory)"
for o in "${OWNERS[@]}"; do [[ "$o" =~ ^([A-Za-z0-9._-]+=)?[UW][A-Z0-9]+$ ]] || die "bad --owner-slack-user '$o' (want U… or BOT=U…)"; done
UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
# ${arr[@]+"${arr[@]}"} expands an empty array safely under set -u on bash < 4.4.
for p in ${PROBES[@]+"${PROBES[@]}"}; do [[ "$p" =~ ^([A-Za-z0-9._-]+=)?$UUID_RE$ ]] || die "bad --probe-delivery '$p' (want <uuid> or BOT=<uuid>)"; done
for a in "${ASSIGN[@]}"; do [[ "$a" =~ ^[A-Za-z0-9._-]+=(#[a-z0-9._-]+|[CG][A-Z0-9]+)$ ]] || die "bad assignment '$a' (want BOT=#channel or BOT=C…)"; done
# owner_for BOT -> the Slack user id for BOT (BOT=U… wins over a bare U…); empty if none.
owner_for() {
  local o bare=""
  for o in "${OWNERS[@]}"; do
    if [[ "$o" == "$1="* ]]; then echo "${o#*=}"; return; fi
    [[ "$o" == *=* ]] || bare="$o"
  done
  echo "$bare"
}
# probes_for BOT -> delivery ids to probe on BOT's connection, one per line.
probes_for() {
  local p
  for p in ${PROBES[@]+"${PROBES[@]}"}; do
    if [[ "$p" == "$1="* ]]; then echo "${p#*=}"; elif [[ "$p" != *=* ]]; then echo "$p"; fi
  done
}
for a in "${ASSIGN[@]}"; do [[ -n "$(owner_for "${a%%=*}")" ]] || die "no --owner-slack-user for ${a%%=*}"; done

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

# evaluate EP RESOURCE USER EVENT_JSON WANT(true|false) LABEL [RULE]
# Asserts .trusted == WANT and, when RULE is given, .rules[RULE] == false.
evaluate() {
  jq -n --arg r "$2" --arg u "$3" --argjson e "$4" '{resourceId:$r, slackUserId:$u, event:$e}' > "$WORK/eval.json"
  local resp
  resp="$(api POST "/chat-endpoints/$1/board-trust/evaluate" "$WORK/eval.json")"
  jq -e --argjson want "$5" --arg rule "${7:-}" \
    '.trusted == $want and ($rule == "" or .rules[$rule] == false) and ($want == false or (.rules | to_entries | all(.value == true)))' \
    <<<"$resp" >/dev/null \
    || die "probe '$6' on endpoint $1: expected trusted=$5${7:+ and $7=false}, got: $(head -c 300 <<<"$resp")"
  log "  probe ok: $6 -> trusted=$5${7:+, $7=false}"
}
# probe_delivery EP DELIVERY_ID -> trusted=false AND rules.plainHuman=false.
probe_delivery() {
  jq -n --arg d "$2" '{deliveryId:$d}' > "$WORK/eval.json"
  local resp
  resp="$(api POST "/chat-endpoints/$1/board-trust/evaluate" "$WORK/eval.json")"
  jq -e '.trusted == false and .rules.plainHuman == false' <<<"$resp" >/dev/null \
    || die "probe-delivery $2 on endpoint $1: expected trusted=false and plainHuman=false (a user-token post must not be a plain human post), got: $(head -c 300 <<<"$resp"); nothing was changed"
  log "  probe ok: delivery $2 -> trusted=false, plainHuman=false"
}

companies="$(api GET /companies)"
jq -e 'type=="array"' <<<"$companies" >/dev/null || companies="$(jq '.companies // .items' <<<"$companies")"
companies="$(jq '[.[] | select((.status // "active") != "archived")]' <<<"$companies")"
[[ "$(jq length <<<"$companies")" -gt 0 ]] || die "no active company visible to this board key"

# All live Slack endpoints across visible companies, once.
endpoints='[]'
for cid in $(jq -r '.[].id' <<<"$companies"); do
  page="$(api GET "/companies/$cid/chat-endpoints" | jq 'if type=="array" then . else .endpoints end')"
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
  owner="$(owner_for "$bot")"

  # Real user-token deliveries first: a failure here leaves everything unchanged.
  while IFS= read -r delivery; do
    if [[ -n "$delivery" ]]; then probe_delivery "$ep" "$delivery"; fi
  done < <(probes_for "$bot")

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
  trusted_count=0; others=()  # expanded below with ${others[@]+...} for set -u on bash < 4.4
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

  # Prove refusals with the dry run (nothing is posted or stored). Each refusal
  # differs from the positive control by exactly one field, from the owner.
  ts="1700000000.000100"
  plain="$(jq -nc --arg ts "$ts" --arg u "$owner" '{type:"message", ts:$ts, user:$u, client_msg_id:"00000000-0000-4000-8000-000000000000", text:"probe"}')"
  evaluate "$ep" "$rid" "$owner" "$(jq -c '. + {bot_id:"B00000000"}' <<<"$plain")" false "bot-authored post" plainHumanTopLevel
  evaluate "$ep" "$rid" "$owner" "$(jq -c '. + {app_id:"A00000000"}' <<<"$plain")" false "app-authored post" plainHumanTopLevel
  evaluate "$ep" "$rid" "$owner" "$(jq -c 'del(.client_msg_id)' <<<"$plain")" false "post without client_msg_id" plainHumanTopLevel
  evaluate "$ep" "$rid" "$owner" "$(jq -c '. + {thread_ts:"1700000000.000001"}' <<<"$plain")" false "thread reply" plainHumanTopLevel
  evaluate "$ep" "$rid" "$owner" "$plain" true "linked owner plain post (positive control)"
  for pair in ${others[@]+"${others[@]}"}; do
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
log "done: $done_count board channel(s)$([[ "$DRY" -eq 1 ]] && echo ' (dry run: no writes; --probe-delivery deliveries were evaluated, synthetic refusal probes skipped)')"
