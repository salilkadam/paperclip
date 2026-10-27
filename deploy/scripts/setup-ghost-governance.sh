#!/usr/bin/env bash
# setup-ghost-governance.sh — make "agents create Ghost posts only as drafts" a
# gateway rule rather than an instruction, for EVERY active company with a
# "Ghost blog" connection, idempotently.
#
# setup-ghost-connections.sh already makes gh_publish_post, gh_unpublish_post
# and gh_delete_post ask-first. But gh_create_post also takes a `status`
# ("draft" by default, "published", or "scheduled" with published_at), so an
# agent could put a post live with it and no board card. gh_update_post cannot:
# its schema has no status or published_at (additionalProperties: false).
#
# Per Ghost connection it ensures one company policy, by exact name:
#   ask first: gh_create_post when the call's `status` is not exactly "draft"
#   (an omitted status is gated too; agents send "draft" explicitly).
# A policy that exists with a different type, priority, selectors or conditions
# (or disabled) is updated in place. Zero Ghost connections found is fatal.
#
# Then it PROVES the gate with real gateway test calls as one of the company's
# agents, against a site that does not exist ("zz-governance-probe"), so nothing
# could be created even if the gate failed:
#   - status "published" -> must be ask_first (the action request is declined);
#   - status omitted     -> must be ask_first (declined);
#   - status "draft"     -> must be allowed, AND the upstream call must have
#     failed (the Ghost server rejects the unknown site). An allowed call that
#     returns a result is fatal and prints it: a real draft may exist.
# Any other outcome is fatal.
#
# Not covered: a board member can turn repeated approvals into a trust rule
# (Settings) that lets matching calls through without a card; that is a
# deliberate board decision, visible in the company's trust rules.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key of an instance admin (`paperclipai token board create --name ghost-gov
# --ttl-days 1`). The key never appears on a command line.
#
# Usage: deploy/scripts/setup-ghost-governance.sh [--company-id <id>] [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
CONN_NAME="Ghost blog"
PROBE_SITE="zz-governance-probe"
ONLY_COMPANY=""; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --company-id) ONLY_COMPANY="${2:?--company-id needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[ghost-governance] $*"; }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"

# api METHOD PATH [json-file]  -> body on stdout; non-2xx is fatal with the body.
api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-ghost-governance/1' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}

desired_policy() {
  jq -n --arg conn "$1" '
    { name: "org-instructions: ask first for Ghost posts created live (non-draft create)",
      description: "Agents create blog posts only as drafts (status: \"draft\" must be sent explicitly). A create that publishes or schedules (or omits status) needs board approval; the approved call then runs exactly once. Publishing a draft goes through gh_publish_post, which is always ask-first.",
      policyType: "require_approval", priority: 40, enabled: true,
      selectors: { toolNames: ["gh_create_post"], connectionId: $conn },
      conditions: { arguments: { fieldNotEquals: { status: "draft" } } } }'
}

# probe CID CONN AGENT LABEL PARAMS_JSON EXPECTED_DECISION
probe() {
  local cid="$1" conn="$2" agent="$3" label="$4" params="$5" want="$6" resp decision ar
  jq -n --arg a "$agent" --argjson p "$params" '{agentId:$a, toolName:"gh_create_post", parameters:$p}' > "$WORK/probe.json"
  resp="$(api POST "/tool-connections/$conn/test-calls" "$WORK/probe.json")"
  decision="$(jq -r '.decision // "none"' <<<"$resp")"
  ar="$(jq -r '.actionRequestId // empty' <<<"$resp")"
  if [[ -n "$ar" ]]; then
    jq -n --arg c "$cid" '{companyId:$c, reason:"ghost-governance probe; never meant to run"}' > "$WORK/decline.json"
    api POST "/tool-gateway/action-requests/$ar/decline" "$WORK/decline.json" >/dev/null
  fi
  [[ "$decision" == "$want" ]] || die "probe '$label' on connection $conn: expected $want, got $decision: $(head -c 300 <<<"$resp")"
  if [[ "$want" == allowed ]]; then
    jq -e '.error != null and .result == null' <<<"$resp" >/dev/null \
      || die "probe '$label' on connection $conn ran upstream and did NOT fail: a real post may exist; delete it: $(head -c 400 <<<"$resp")"
  fi
  log "  probe ok: $label -> $decision"
}

companies="$(api GET /companies)"
jq -e 'type=="array"' <<<"$companies" >/dev/null || companies="$(jq '.companies // .items' <<<"$companies")"
companies="$(jq '[.[] | select((.status // "active") != "archived")]' <<<"$companies")"
[[ -z "$ONLY_COMPANY" ]] || companies="$(jq --arg id "$ONLY_COMPANY" '[.[] | select(.id==$id)]' <<<"$companies")"
[[ "$(jq length <<<"$companies")" -gt 0 ]] || die "no matching active company visible to this board key"

total=0
for cid in $(jq -r '.[].id' <<<"$companies"); do
  cname="$(jq -r --arg id "$cid" '.[]|select(.id==$id)|.name' <<<"$companies")"
  conns="$(api GET "/companies/$cid/tools/connections" | jq --arg n "$CONN_NAME" '(.connections // .) | [.[] | select(.status=="active" and .name==$n)]')"
  n="$(jq length <<<"$conns")"
  if [[ "$n" -eq 0 ]]; then log "$cname: no active '$CONN_NAME' connection, skipped"; continue; fi
  agent="$(api GET "/companies/$cid/agents" | jq -r '[.[] | select(.status=="idle" or .status=="active" or .status=="running")][0].id // empty')"
  [[ -n "$agent" ]] || die "$cname has a Ghost connection but no agent to prove the gate with"
  existing="$(api GET "/companies/$cid/tools/policies" | jq '(.policies // .)')"

  for conn in $(jq -r '.[].id' <<<"$conns"); do
    log "$cname: Ghost connection $conn"
    want="$(desired_policy "$conn")"
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
    if [[ "$DRY" -eq 0 ]]; then
      probe "$cid" "$conn" "$agent" "published" "{\"tenant_id\":\"$PROBE_SITE\",\"title\":\"governance probe\",\"status\":\"published\"}" ask_first
      probe "$cid" "$conn" "$agent" "status omitted" "{\"tenant_id\":\"$PROBE_SITE\",\"title\":\"governance probe\"}" ask_first
      probe "$cid" "$conn" "$agent" "explicit draft" "{\"tenant_id\":\"$PROBE_SITE\",\"title\":\"governance probe\",\"status\":\"draft\"}" allowed
    fi
    total=$((total + 1))
  done
done
[[ "$total" -gt 0 ]] || die "no active '$CONN_NAME' connection found in any target company (nothing governed)"
log "done: $total Ghost connection(s) governed$([[ "$DRY" -eq 1 ]] && echo ' (dry run, no writes, no probes)')"
