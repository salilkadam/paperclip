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

[[ "$fail" -eq 0 ]] && echo "all apify governance checks passed" || { echo "apify governance checks FAILED" >&2; exit 1; }
