#!/usr/bin/env bash
# setup-apify-governance.sh — apply the Apify read governance to EVERY active
# company that has an Apify connection, idempotently. Run it after connecting
# Apify for a new company, after any catalog refresh of that connection, or just
# re-run it for all of them.
#
# What the card's pinned URL gives: Apify's MCP server, given `?tools=` with only
# actor names, loads no tool categories (no call-actor, search-actors, docs or
# storage-listing tools) and adds four run helpers: get-actor-run,
# get-dataset-items, get-key-value-store-record and abort-actor-run. Paperclip
# lists newly discovered tools as Allowed after a catalog refresh, so this
# script VERIFIES the synced catalog instead of trusting the URL.
#
# Per Apify connection:
#   1. Check the synced catalog against an exact allowlist: the pinned actors'
#      tool names plus the four helpers. Any other tool is fatal.
#   2. Ensure three company policies, by exact name:
#      a. block: abort-actor-run and get-key-value-store-record (the skills
#         never need them, and with an account-wide token they reach any run
#         or store by id), plus the generic tools by name, so a future catalog
#         refresh that adds them is still blocked;
#      b. rate_limit: every actor tool on the connection, shared counter per
#         company and connection, ACTOR_RUNS_PER_DAY runs per day (default 60).
#         Each run bills per result; this caps how many runs agents can start.
#      A policy that exists with different type, priority, selectors, conditions
#      or config (or disabled) is updated in place.
#   3. PROVE with gateway test calls as one of the company's agents:
#      - abort-actor-run on a nonexistent run -> must be off;
#      - get-actor-run on a nonexistent run -> must be allowed (Apify answers
#        "not found"; nothing is billed).
#      and read the rate-limit policy back to check its limit.
# Zero Apify connections found is fatal; so is any failed check.
#
# Not covered (accepted risk): get-dataset-items and get-actor-run accept any id
# the token can reach. Recommend an Apify token scoped to these actors.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key of an instance admin (`paperclipai token board create --name apify-gov
# --ttl-days 1`). The key never appears on a command line.
#
# Usage: deploy/scripts/setup-apify-governance.sh [--company-id <id>] [--actor-runs-per-day N] [--dry-run]
set -euo pipefail
API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
ONLY_COMPANY=""; DRY=0; RUNS_PER_DAY="${ACTOR_RUNS_PER_DAY:-60}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --company-id) ONLY_COMPANY="${2:?--company-id needs a value}"; shift 2 ;;
    --actor-runs-per-day) RUNS_PER_DAY="${2:?--actor-runs-per-day needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,46p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[apify-governance] $*"; }
[[ "$RUNS_PER_DAY" =~ ^[1-9][0-9]*$ ]] || die "--actor-runs-per-day must be a positive integer"
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"
WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"
# api METHOD PATH [json-file]  -> body on stdout; non-2xx is fatal with the body.
api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-apify-governance/2' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}

# The card's pinned actors (packages/shared/src/app-definitions/apify.json) as
# the exact MCP tool names Apify derives from them (apify/apify-mcp-server
# actorNameToToolName: `user--actor`, names over 64 chars truncated to 59 plus
# `-` and the first 4 hex of sha256("user/actor")).
ACTOR_TOOLS='["apimaestro--linkedin-post-detail","apimaestro--linkedin-post-comments-replies-engagements-scra-1137","apimaestro--linkedin-profile-comments","scraping_solutions--linkedin-posts-engagers-likers-and-comm-cf07","xquik--x-tweet-scraper","apify--instagram-hashtag-scraper","apify--instagram-profile-scraper","igview-owner--threads-search-scraper","apify--threads-profile-api-scraper","clockworks--tiktok-scraper","clockworks--tiktok-comments-scraper","apify--facebook-pages-scraper","danek--facebook-comments-ppr","streamers--youtube-scraper","streamers--youtube-comments-scraper"]'
HELPERS='["get-actor-run","get-dataset-items","get-key-value-store-record","abort-actor-run"]'
# Every other tool Apify's server can expose (HELPER_TOOLS in its src/const.ts),
# blocked by name so a catalog refresh that adds one is still blocked.
GENERIC='["build-actor","get-actor-build","get-actor-build-log","get-actor-build-list","call-actor","create-actor","call-actor-widget","delete-actor","fetch-actor-details","fetch-actor-details-widget","get-actor-list","get-actor-run-widget","get-actor-run-log","get-actor-run-list","get-actor-task","create-actor-task","update-actor-task","publish-actor-task","unpublish-actor-task","create-actor-version","delete-actor-version","get-actor-version","update-actor-version","get-dataset","get-dataset-list","get-dataset-schema","get-key-value-store-list","get-key-value-store","get-key-value-store-keys","create-schedule","get-schedule","update-schedule","delete-schedule","search-actors","search-actors-widget","search-apify-docs","fetch-apify-docs","apify-api-search","apify-api-details","apify-api-read","apify-api-write","report-problem","apify--rag-web-browser","apify-slash-rag-web-browser"]'

# actor_tools CATALOG_JSON -> JSON array of the actor tools present; dies on any
# tool outside the allowlist (pinned actor tools + the four helpers).
actor_tools() {
  jq -e --argjson actors "$ACTOR_TOOLS" --argjson helpers "$HELPERS" '
    [ (.catalog // .)[] | (.toolName // .name) ] as $names
    | ($names | map(select(. as $n | (($actors + $helpers) | index($n)) | not))) as $unknown
    | if ($names | length) == 0 then error("catalog is empty; refresh the connection catalog first")
      elif ($unknown | length) > 0 then error("tools outside the allowlist: \($unknown | join(", "))")
      elif ($names | map(select(. as $n | $actors | index($n))) | length) == 0 then error("no pinned actor tools in the catalog")
      else $names | map(select(. as $n | $actors | index($n))) end' <<<"$1" || die "catalog check failed"
}

# desired_policies CONNECTION_ID ACTOR_TOOLS_JSON -> JSON array of the policies.
desired_policies() {
  jq -n --arg conn "$1" --argjson actors "$2" --argjson generic "$GENERIC" --argjson runs "$RUNS_PER_DAY" '[
    { name: "org-instructions: block Apify run control, stores and generic tools",
      description: "Agents run only the pinned social-reading actors and read their runs and datasets. Aborting runs, reading key-value stores, running other actors and browsing the account are operator work.",
      policyType: "block", priority: 10, enabled: true,
      selectors: { toolNames: (["abort-actor-run","get-key-value-store-record"] + $generic), connectionId: $conn },
      conditions: null, config: null },
    { name: "org-instructions: rate-limit Apify actor runs",
      description: "Each actor run bills the company Apify account per result. One shared counter per company and connection caps runs per day.",
      policyType: "rate_limit", priority: 40, enabled: true,
      selectors: { toolNames: $actors, connectionId: $conn },
      conditions: null,
      config: { rateLimit: { limit: $runs, windowSeconds: 86400, keyBy: ["company","connection"] } } }
  ]'
}

# probe CID CONN AGENT LABEL TOOL PARAMS_JSON EXPECTED_DECISION [EXPECTED_REASON_CODE]
probe() {
  local cid="$1" conn="$2" agent="$3" label="$4" tool="$5" params="$6" want="$7" reason="${8:-}" resp decision ar got
  jq -n --arg a "$agent" --arg t "$tool" --argjson p "$params" '{agentId:$a, toolName:$t, parameters:$p}' > "$WORK/probe.json"
  resp="$(api POST "/tool-connections/$conn/test-calls" "$WORK/probe.json")"
  decision="$(jq -r '.decision // "none"' <<<"$resp")"
  ar="$(jq -r '.actionRequestId // empty' <<<"$resp")"
  if [[ -n "$ar" ]]; then
    jq -n --arg c "$cid" '{companyId:$c, reason:"apify-governance probe; never meant to run"}' > "$WORK/decline.json"
    api POST "/tool-gateway/action-requests/$ar/decline" "$WORK/decline.json" >/dev/null
  fi
  [[ "$decision" == "$want" ]] || die "probe '$label' on connection $conn: expected $want, got $decision: $(head -c 300 <<<"$resp")"
  if [[ -n "$reason" ]]; then
    got="$(jq -r '.error.reasonCode // "none"' <<<"$resp")"
    [[ "$got" == "$reason" ]] || die "probe '$label' on connection $conn: expected reason $reason, got $got"
  fi
  log "  probe ok: $label -> $decision${reason:+ ($reason)}"
}

companies="$(api GET /companies)"
jq -e 'type=="array"' <<<"$companies" >/dev/null || companies="$(jq '.companies // .items' <<<"$companies")"
companies="$(jq '[.[] | select((.status // "active") != "archived")]' <<<"$companies")"
[[ -z "$ONLY_COMPANY" ]] || companies="$(jq --arg id "$ONLY_COMPANY" '[.[] | select(.id==$id)]' <<<"$companies")"
[[ "$(jq length <<<"$companies")" -gt 0 ]] || die "no matching active company visible to this board key"
log "board key sees $(jq length <<<"$companies") target companies; actor runs per day: $RUNS_PER_DAY"

total=0
for cid in $(jq -r '.[].id' <<<"$companies"); do
  cname="$(jq -r --arg id "$cid" '.[]|select(.id==$id)|.name' <<<"$companies")"
  apps="$(api GET "/companies/$cid/tools/applications" | jq '[(.applications // .)[] | {key:.id, value:(.name // "")}] | from_entries')"
  conns="$(api GET "/companies/$cid/tools/connections" | jq --argjson apps "$apps" '(.connections // .)
            | [.[] | select(.status=="active")
                   | select(((.name // "")|test("apify";"i"))
                            or (($apps[.applicationId // ""] // "")|test("apify";"i"))
                            or ((.config.url // .transportConfig.url // .url // "")|test("mcp\\.apify\\.com")))]')"
  n="$(jq length <<<"$conns")"
  if [[ "$n" -eq 0 ]]; then log "$cname: no active Apify connection, skipped"; continue; fi
  agent="$(api GET "/companies/$cid/agents" | jq -r '[.[] | select(.status=="idle" or .status=="active" or .status=="running")][0].id // empty')"
  [[ -n "$agent" ]] || die "$cname has an Apify connection but no agent to prove the gate with"
  existing="$(api GET "/companies/$cid/tools/policies" | jq '(.policies // .)')"

  for conn in $(jq -r '.[].id' <<<"$conns"); do
    log "$cname: Apify connection $conn"
    actors="$(actor_tools "$(api GET "/tool-connections/$conn/catalog")")"
    log "  catalog ok: $(jq length <<<"$actors") pinned actor tools, nothing outside the allowlist"
    desired_policies "$conn" "$actors" | jq -c '.[]' | while read -r want; do
      name="$(jq -r .name <<<"$want")"
      have="$(jq -c --arg n "$name" --arg conn "$conn" '[.[] | select(.name==$n and .selectors.connectionId==$conn)][0] // empty' <<<"$existing")"
      if [[ -z "$have" ]]; then
        log "  create: $name"
        [[ "$DRY" -eq 1 ]] || { printf '%s' "$want" > "$WORK/p.json"; api POST "/companies/$cid/tools/policies" "$WORK/p.json" >/dev/null; }
      elif ! jq -e --argjson w "$want" '(.policyType==$w.policyType) and (.enabled==true) and (.priority==$w.priority)
               and ((.selectors | .toolNames |= sort)==($w.selectors | .toolNames |= sort))
               and (.conditions==$w.conditions) and ((.config // null)==$w.config)' <<<"$have" >/dev/null; then
        log "  update (drifted): $name"
        [[ "$DRY" -eq 1 ]] || { printf '%s' "$want" > "$WORK/p.json"; api PATCH "/companies/$cid/tools/policies/$(jq -r .id <<<"$have")" "$WORK/p.json" >/dev/null; }
      else
        log "  ok: $name"
      fi
    done
    if [[ "$DRY" -eq 0 ]]; then
      probe "$cid" "$conn" "$agent" "abort a run" abort-actor-run '{"runId":"paperclip-governance-probe"}' off deny_policy_block
      probe "$cid" "$conn" "$agent" "read a run" get-actor-run '{"runId":"paperclip-governance-probe"}' allowed
      limit="$(api GET "/companies/$cid/tools/policies" | jq -r --arg conn "$conn" '[(.policies // .)[]
                | select(.name=="org-instructions: rate-limit Apify actor runs" and .selectors.connectionId==$conn and .enabled==true)][0].config.rateLimit.limit // empty')"
      [[ "$limit" == "$RUNS_PER_DAY" ]] || die "rate-limit policy on connection $conn reads back as '${limit:-missing}', expected $RUNS_PER_DAY"
      log "  rate limit ok: $limit actor runs per day"
    fi
    total=$((total + 1))
  done
done
[[ "$total" -gt 0 ]] || die "no active Apify connection found in any target company (nothing governed)"
log "done: $total Apify connection(s) governed$([[ "$DRY" -eq 1 ]] && echo ' (dry run, no writes, no probes)')"
