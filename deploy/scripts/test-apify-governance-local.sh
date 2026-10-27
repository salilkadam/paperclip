#!/usr/bin/env bash
# test-apify-governance-local.sh — offline gate for setup-apify-governance.sh.
# Loads its constants and pure functions (no API calls) and checks the catalog
# allowlist and the desired policies against fixture catalogs, including
# planted defects that must fail.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/setup-apify-governance.sh"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
# Everything from the constants through desired_policies, without the main loop.
eval "$(sed -n '/^ACTOR_TOOLS=/,/^# probe CID/p' "$SRC" | sed '$d')"
die() { echo "die: $*" >&2; return 1; }
RUNS_PER_DAY=60
fail=0
pass() { echo "ok   $1"; }
bad() { echo "FAIL $1" >&2; fail=1; }

catalog() { jq -n --argjson names "$1" '{catalog: ($names | map({name: ., toolName: .}))}'; }
full="$(jq -c '. ' <<<"$ACTOR_TOOLS")"
helpers="$(jq -c '.' <<<"$HELPERS")"

# 1. The real pinned surface passes and returns all 15 actor tools.
out="$(actor_tools "$(catalog "$(jq -c -n --argjson a "$full" --argjson h "$helpers" '$a + $h')")" 2>/dev/null)" \
  && [[ "$(jq length <<<"$out")" == 15 ]] && pass "pinned catalog accepted (15 actor tools)" || bad "pinned catalog rejected"

# 2-5. Planted defects must fail.
for planted in call-actor search-actors apify-api-write some-owner--unpinned-actor; do
  if actor_tools "$(catalog "$(jq -c -n --argjson a "$full" --arg x "$planted" '$a + [$x]')")" >/dev/null 2>&1; then
    bad "catalog with $planted was accepted"
  else
    pass "catalog with $planted rejected"
  fi
done
actor_tools '{"catalog":[]}' >/dev/null 2>&1 && bad "empty catalog accepted" || pass "empty catalog rejected"
actor_tools "$(catalog "$helpers")" >/dev/null 2>&1 && bad "helpers-only catalog accepted" || pass "helpers-only catalog rejected"

# 6. Policies: block covers abort/kv-store and every generic name; rate limit covers exactly the actor tools.
pol="$(desired_policies 00000000-0000-0000-0000-000000000000 "$full")"
jq -e '.[0].policyType=="block" and (.[0].selectors.toolNames | index("abort-actor-run") and index("get-key-value-store-record") and index("call-actor"))
       and (.[0].selectors.toolNames | index("get-actor-run") | not) and (.[0].selectors.toolNames | index("get-dataset-items") | not)' <<<"$pol" >/dev/null \
  && pass "block policy covers run control and generic tools, leaves reads" || bad "block policy selectors wrong"
jq -e --argjson a "$full" '.[1].policyType=="rate_limit" and (.[1].selectors.toolNames|sort)==($a|sort)
       and .[1].config.rateLimit.limit==60 and .[1].config.rateLimit.windowSeconds==86400
       and .[1].config.rateLimit.keyBy==["company","connection"]' <<<"$pol" >/dev/null \
  && pass "rate-limit policy covers exactly the actor tools, 60/day per connection" || bad "rate-limit policy wrong"
# No actor tool may also be blocked, and no generic tool may be rate-limited only.
jq -e '(.[0].selectors.toolNames - (.[0].selectors.toolNames - .[1].selectors.toolNames)) | length == 0' <<<"$pol" >/dev/null \
  && pass "block and rate-limit selectors are disjoint" || bad "block and rate-limit overlap"

# 7. Apify's full server tool list (apify-mcp-server src/const.ts HELPER_TOOLS, 46
#    names) minus the two reads agents need must all be blocked. Kept here as an
#    independent copy so dropping a name from the script's GENERIC fails.
server_tools='["build-actor","get-actor-build","get-actor-build-log","get-actor-build-list","call-actor","create-actor","call-actor-widget","delete-actor","fetch-actor-details","fetch-actor-details-widget","get-actor-list","abort-actor-run","get-actor-run","get-actor-run-widget","get-actor-run-log","get-actor-run-list","get-actor-task","create-actor-task","update-actor-task","publish-actor-task","unpublish-actor-task","create-actor-version","delete-actor-version","get-actor-version","update-actor-version","get-dataset","get-dataset-list","get-dataset-items","get-dataset-schema","get-key-value-store-list","get-key-value-store","get-key-value-store-keys","get-key-value-store-record","create-schedule","get-schedule","update-schedule","delete-schedule","search-actors","search-actors-widget","search-apify-docs","fetch-apify-docs","apify-api-search","apify-api-details","apify-api-read","apify-api-write","report-problem"]'
jq -e --argjson all "$server_tools" '($all - ["get-actor-run","get-dataset-items"]) - .[0].selectors.toolNames | length == 0' <<<"$pol" >/dev/null \
  && pass "block policy covers all 44 other Apify server tools" || bad "block policy misses Apify server tools: $(jq -c --argjson all "$server_tools" '($all - ["get-actor-run","get-dataset-items"]) - .[0].selectors.toolNames' <<<"$pol")"

# 8. Both policies enabled, bound to the connection, block evaluated first.
jq -e 'all(.[]; .enabled == true and .selectors.connectionId == "00000000-0000-0000-0000-000000000000")
       and .[0].priority < .[1].priority and .[0].priority < 40' <<<"$pol" >/dev/null \
  && pass "policies enabled, scoped to the connection, block evaluated first" || bad "policy enabled/scope/priority wrong"

# 9. Independent check of the pinned names: re-derive them from the actor ids with
#    Apify's rule (64-char cap, 4-hex sha256 suffix), so a typo in ACTOR_TOOLS fails.
if command -v python3 >/dev/null; then
  derived="$(python3 -I -c '
import hashlib, json, sys
ids = json.load(open(sys.argv[1]))["methods"][0]["defaults"]["serverUrl"].split("?tools=", 1)[1].split(",")
def name(a):
    u, n = a.split("/", 1); full = u.replace(".", "-dot-") + "--" + n
    return full if len(full) <= 64 else full[:59] + "-" + hashlib.sha256(a.encode()).hexdigest()[:4]
print(json.dumps([name(a) for a in ids]))' "$HERE/../../packages/shared/src/app-definitions/apify.json")"
  jq -e --argjson d "$derived" '(. | sort) == ($d | sort)' <<<"$ACTOR_TOOLS" >/dev/null \
    && pass "ACTOR_TOOLS match names derived from the card's pinned URL" || bad "ACTOR_TOOLS differ from the card: $derived"
else
  bad "python3 is required to re-derive the pinned tool names"
fi

[[ "$fail" -eq 0 ]] && echo "all apify governance checks passed" || { echo "apify governance checks FAILED" >&2; exit 1; }
