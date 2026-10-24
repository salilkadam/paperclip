#!/usr/bin/env bash
# test-ghost-connections-local.sh — run setup-ghost-connections.sh against a REAL
# Paperclip image (default: the one production runs) with throwaway state, and
# the REAL ghost MCP gateway + per-company keys from Vault.
#
# Proves, end to end:
#   - both companies get a "Ghost blog" connection; re-running is idempotent
#   - each company's agent sees only its own site (gh_list_sites)
#   - a Bionic agent asking for the Reliora site is refused (403 from the server)
#   - gh_publish_post is held for approval (decision "ask_first"), not run
#   - the gateway key is stored as a company secret and never returned
#
# Requires: docker curl jq kubectl openssl; kubeconfig able to create tokens for bionicorg/bionic-org-ops (Vault access via lib/vault-ops.sh). Creates and removes
# a container `pcghost-test` on network 172.29.73.0/24. No production writes:
# the MCP calls are reads plus ask-first holds (nothing is published).
#
# Usage: deploy/scripts/test-ghost-connections-local.sh [image]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${1:-docker4zerocool/bionic:$(kubectl get deploy bionic-org -n bionicorg -o jsonpath='{.spec.template.spec.containers[0].image}' | sed 's/.*://')}"
NAME=pcghost-test NET=pcghost-net IP=172.29.73.10 U="http://172.29.73.10:3100"
for b in docker curl jq kubectl openssl; do command -v "$b" >/dev/null || { echo "missing $b" >&2; exit 69; }; done
W="$(mktemp -d)"; chmod 700 "$W"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$W"; }
trap cleanup EXIT; cleanup; W="$(mktemp -d)"; chmod 700 "$W"
fail() { echo "FAIL: $*" >&2; docker logs --tail 20 "$NAME" >&2 2>/dev/null || true; exit 1; }
cli() { docker exec -u node "$NAME" sh -c "cd /app && node --import ./server/node_modules/tsx/dist/loader.mjs cli/src/index.ts $*"; }

docker network create --subnet 172.29.73.0/24 "$NET" >/dev/null
docker run -d --name "$NAME" --network "$NET" --ip "$IP" \
  --tmpfs /paperclip:rw,size=4g,uid=1000,gid=1000 \
  -e PAPERCLIP_PUBLIC_URL="$U" -e BETTER_AUTH_URL="$U" \
  -e BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="$(openssl rand -hex 32)" \
  "$IMAGE" >/dev/null
for _ in $(seq 1 120); do curl -sf -m 3 "$U/api/health" >/dev/null && break; sleep 3; done
curl -sf -m 3 "$U/api/health" >/dev/null || fail "Paperclip did not start"
echo "== booted $IMAGE"

# Admin + board key, the documented way (sign up, bootstrap invite, accept).
PW="$(openssl rand -hex 12)"; J="$W/cookies"
post() { curl -sS -o "$W/r" -w '%{http_code}' -c "$J" -b "$J" -H 'Content-Type: application/json' -H "Origin: $U" -X POST "$U$1" --data "$2"; }
[[ "$(post /api/auth/sign-up/email "$(jq -cn --arg p "$PW" '{name:"Test Admin",email:"admin@pcghost.test",password:$p}')")" =~ ^2 ]] || fail "sign-up"
# onboard writes config.json (needed by bootstrap-ceo), then tries to start its
# own server, which would block: bound it.
docker exec -u node "$NAME" sh -c "cd /app && timeout 120 node --import ./server/node_modules/tsx/dist/loader.mjs cli/src/index.ts onboard --yes --bind lan --no-install-service" >/dev/null 2>&1 || true
invite="$(cli auth bootstrap-ceo --base-url "$U" 2>&1 | grep -oE 'pcp_bootstrap_[[:alnum:]]+' | head -1)"
[[ -n "$invite" ]] || fail "bootstrap-ceo printed no invite"
[[ "$(post "/api/invites/$invite/accept" '{"requestType":"human"}')" =~ ^2 ]] || fail "accept bootstrap invite"
[[ "$(post /api/board-api-keys '{"name":"ghost-test"}')" =~ ^2 ]] || fail "create board key"
jq -r .token "$W/r" > "$W/boardkey"; chmod 600 "$W/boardkey"; rm -f "$W/r"
printf 'Authorization: Bearer %s\n' "$(cat "$W/boardkey")" > "$W/auth"
api() { curl -sS -H @"$W/auth" -H 'Content-Type: application/json' -X "$1" "$U/api$2" ${3:+--data "$3"}; }
echo "== admin and board key ready"

declare -A CID AID
for pair in "bionic:Bionic AI Solutions" "reliora:Reliora Inc"; do
  s="${pair%%:*}"; CID[$s]="$(api POST /companies "$(jq -cn --arg n "${pair#*:}" '{name:$n}')" | jq -r .id)"
  AID[$s]="$(api POST "/companies/${CID[$s]}/agents" '{"name":"Blog Writer","role":"general"}' | jq -r .id)"
  [[ "${CID[$s]}" =~ ^[0-9a-f-]{36}$ && "${AID[$s]}" =~ ^[0-9a-f-]{36}$ ]] || fail "create company/agent for $s"
done

echo "== setup (first run)"
PAPERCLIP_API_BASE="$U" PAPERCLIP_BOARD_KEY_FILE="$W/boardkey" "$HERE/setup-ghost-connections.sh" | tee "$W/run1"
grep -q "sees only site 'bionic'" "$W/run1" && grep -q "sees only site 'reliora'" "$W/run1" || fail "first run did not verify both"
echo "== setup (re-run: idempotent)"
PAPERCLIP_API_BASE="$U" PAPERCLIP_BOARD_KEY_FILE="$W/boardkey" "$HERE/setup-ghost-connections.sh" > "$W/run2"
[[ "$(grep -c 'exists; re-applying access' "$W/run2")" -eq 2 ]] || fail "re-run created new connections"

conn() { api GET "/companies/${CID[$1]}/tools/connections" | jq -r '[(if type=="array" then . else .connections end)[] | select(.name=="Ghost blog")] | if length==1 then .[0].id else error("not exactly one") end'; }
tc() { api POST "/tool-connections/$(conn "$1")/test-calls" "$(jq -cn --arg a "${AID[$1]}" --arg t "$2" --argjson p "$3" '{agentId:$a,toolName:$t,parameters:$p}')"; }

out="$(tc bionic gh_site_info '{"tenant_id":"reliora"}')"
grep -q "not available to this API key" <<<"$out" || fail "bionic agent was not refused on reliora: $(head -c 300 <<<"$out")"
echo "ok: bionic agent refused on reliora"
out="$(tc reliora gh_site_info '{"tenant_id":"bionic"}')"
grep -q "not available to this API key" <<<"$out" || fail "reliora agent was not refused on bionic"
echo "ok: reliora agent refused on bionic"

out="$(tc bionic gh_publish_post '{"tenant_id":"bionic","post_id":"65f0a1b2c3d4e5f601234567"}')"
[[ "$(jq -r '.decision // empty' <<<"$out")" == ask_first ]] || fail "publish was not held for approval: $(head -c 300 <<<"$out")"
echo "ok: gh_publish_post held for approval (ask_first)"

sec="$(api GET "/companies/${CID[bionic]}/secrets")"
[[ "$(jq '[(if type=="array" then . else .secrets end)[] | select(.key|test("x-api-key"))] | length' <<<"$sec")" -eq 1 ]] || fail "expected one gateway-key secret"
jq -e '[.. | objects | has("value")] | any | not' <<<"$sec" >/dev/null || fail "secret list exposes a value field"
echo "ok: key stored as one company secret; no value returned"
echo "RESULT: ALL CHECKS PASSED ($IMAGE)"
