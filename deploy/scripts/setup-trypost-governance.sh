#!/usr/bin/env bash
# setup-trypost-governance.sh — apply the TryPost publishing governance to EVERY
# active company that has a TryPost connection, idempotently. Run it after
# connecting TryPost for a new company (or just re-run it for all of them).
#
# The rule: agents prepare posts as drafts; anything that goes live needs a
# board approval card in Paperclip, and the approved call then runs exactly once.
# The bundled `trypost` skill teaches agents the same workflow.
#
# Per TryPost connection it ensures three company policies, by exact name:
#   1. ask first: publish-post, approve-post, move-post-to-slot,
#      set-post-recurrence, delete-post, the repurpose tools (they auto-post
#      replicated videos) and the posting-schedule/queue tools (they move
#      already-approved posts) — always;
#   2. ask first: create-post, create-posts, update-post when the call's
#      `status` is not exactly "draft" (an omitted status is gated too, so an
#      edit to an already-scheduled post cannot slip through);
#   3. block: API-key and webhook tools (operator work).
# A policy that exists with a different type, priority, selectors or conditions
# (or disabled) is updated in place. Zero TryPost connections found is fatal.
# Policy names are unique per company, so one TryPost connection per company
# is supported; a second one stops the run with the server's 409.
#
# Then it PROVES the gate with real gateway test calls as one of the company's
# agents, using an all-zero social_account_id so nothing could post even if the
# gate failed:
#   - status "publishing"  -> must be ask_first (the action request is declined);
#   - status omitted       -> must be ask_first (declined);
#   - status "draft"       -> must be allowed (TryPost rejects the fake account).
# Any other outcome is fatal.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key of an instance admin (`paperclipai token board create --name trypost-gov
# --ttl-days 1`). The key never appears on a command line.
#
# Usage: deploy/scripts/setup-trypost-governance.sh [--company-id <id>] [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
ZERO="00000000-0000-0000-0000-000000000000"
ONLY_COMPANY=""; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --company-id) ONLY_COMPANY="${2:?--company-id needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[trypost-governance] $*"; }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"

# api METHOD PATH [json-file]  -> body on stdout; non-2xx is fatal with the body.
api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-trypost-governance/1' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}

# desired_policies CONNECTION_ID -> JSON array of the three policies.
desired_policies() {
  jq -n --arg conn "$1" '[
    { name: "org-instructions: ask first for TryPost publishing",
      description: "The board publishes; agents draft.",
      policyType: "require_approval", priority: 40, enabled: true,
      selectors: { toolNames: ["publish-post-tool","approve-post-tool","move-post-to-slot-tool","set-post-recurrence-tool","delete-post-tool",
                               "create-repurpose-tool","activate-repurpose-tool","resume-repurpose-tool","update-repurpose-tool",
                               "update-posting-schedule-tool","generate-posting-schedule-tool","copy-posting-schedule-tool","reorder-queue-tool"], connectionId: $conn },
      conditions: null },
    { name: "org-instructions: ask first for TryPost go-live (non-draft create/update)",
      description: "Agents may create and edit posts only as drafts (status: \"draft\" must be sent explicitly). Any create/update that schedules, queues or publishes (or omits status) needs board approval; the approved call then runs exactly once.",
      policyType: "require_approval", priority: 40, enabled: true,
      selectors: { toolNames: ["create-post-tool","create-posts-tool","update-post-tool"], connectionId: $conn },
      conditions: { arguments: { fieldNotEquals: { status: "draft" } } } },
    { name: "org-instructions: block TryPost keys and webhooks",
      description: "Credential and integration changes are operator work.",
      policyType: "block", priority: 40, enabled: true,
      selectors: { toolNames: ["create-api-key-tool","delete-api-key-tool","rotate-webhook-secret-tool","create-webhook-tool","update-webhook-tool","delete-webhook-tool","send-webhook-test-tool","replay-webhook-log-tool"], connectionId: $conn },
      conditions: null }
  ]'
}

# probe CID CONN AGENT LABEL PARAMS_JSON EXPECTED_DECISION
probe() {
  local cid="$1" conn="$2" agent="$3" label="$4" params="$5" want="$6" resp decision ar
  jq -n --arg a "$agent" --argjson p "$params" '{agentId:$a, toolName:"create-post-tool", parameters:$p}' > "$WORK/probe.json"
  resp="$(api POST "/tool-connections/$conn/test-calls" "$WORK/probe.json")"
  decision="$(jq -r '.decision // "none"' <<<"$resp")"
  ar="$(jq -r '.actionRequestId // empty' <<<"$resp")"
  if [[ -n "$ar" ]]; then
    jq -n --arg c "$cid" '{companyId:$c, reason:"trypost-governance probe; never meant to run"}' > "$WORK/decline.json"
    api POST "/tool-gateway/action-requests/$ar/decline" "$WORK/decline.json" >/dev/null
  fi
  [[ "$decision" == "$want" ]] || die "probe '$label' on connection $conn: expected $want, got $decision: $(head -c 300 <<<"$resp")"
  log "  probe ok: $label -> $decision"
}

companies="$(api GET /companies)"
jq -e 'type=="array"' <<<"$companies" >/dev/null || companies="$(jq '.companies // .items' <<<"$companies")"
companies="$(jq '[.[] | select((.status // "active") != "archived")]' <<<"$companies")"
[[ -z "$ONLY_COMPANY" ]] || companies="$(jq --arg id "$ONLY_COMPANY" '[.[] | select(.id==$id)]' <<<"$companies")"
[[ "$(jq length <<<"$companies")" -gt 0 ]] || die "no matching active company visible to this board key"
log "board key sees $(jq length <<<"$companies") target companies"

total=0
for cid in $(jq -r '.[].id' <<<"$companies"); do
  cname="$(jq -r --arg id "$cid" '.[]|select(.id==$id)|.name' <<<"$companies")"
  apps="$(api GET "/companies/$cid/tools/applications" | jq '[(.applications // .)[] | {key:.id, value:(.name // "")}] | from_entries')"
  conns="$(api GET "/companies/$cid/tools/connections" | jq --argjson apps "$apps" '(.connections // .)
            | [.[] | select(.status=="active")
                   | select(((.name // "")|test("trypost";"i"))
                            or (($apps[.applicationId // ""] // "")|test("trypost";"i"))
                            or ((.url // .config.url // "")|test("/mcp/trypost")))]')"
  n="$(jq length <<<"$conns")"
  if [[ "$n" -eq 0 ]]; then log "$cname: no active TryPost connection, skipped"; continue; fi
  agent="$(api GET "/companies/$cid/agents" | jq -r '[.[] | select(.status=="idle" or .status=="active" or .status=="running")][0].id // empty')"
  [[ -n "$agent" ]] || die "$cname has a TryPost connection but no agent to prove the gate with"
  existing="$(api GET "/companies/$cid/tools/policies" | jq '(.policies // .)')"

  for conn in $(jq -r '.[].id' <<<"$conns"); do
    log "$cname: TryPost connection $conn"
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
      probe "$cid" "$conn" "$agent" "publish now" "{\"social_account_id\":\"$ZERO\",\"status\":\"publishing\",\"content\":\"governance probe\"}" ask_first
      probe "$cid" "$conn" "$agent" "status omitted" "{\"social_account_id\":\"$ZERO\",\"content\":\"governance probe\"}" ask_first
      probe "$cid" "$conn" "$agent" "explicit draft" "{\"social_account_id\":\"$ZERO\",\"status\":\"draft\",\"content\":\"governance probe\"}" allowed
    fi
    total=$((total + 1))
  done
done
[[ "$total" -gt 0 ]] || die "no active TryPost connection found in any target company (nothing governed)"
log "done: $total TryPost connection(s) governed$([[ "$DRY" -eq 1 ]] && echo ' (dry run, no writes, no probes)')"
