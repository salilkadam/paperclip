#!/usr/bin/env bash
# setup-ghost-plugin.sh — install the Ghost Blog plugin ONCE for the instance and
# configure it per company, idempotently.
#
#   Company "Bionic AI Solutions" -> http://ghost-bionic.blog.svc.cluster.local:2368
#   Company "Reliora …"           -> http://ghost-reliora.blog.svc.cluster.local:2368
#
# Steps:
#   1. install paperclip.ghost-blog from the image's bundled path (once);
#   2. per company: a company secret "ghost_admin_api_key" holding THAT
#      company's Ghost Admin API key (Vault t6-apps/ghost/config:<site>_admin_api_key;
#      write-only in Paperclip), and the plugin config for that company
#      (siteUrl + a secret_ref to its own secret);
#   3. per company: a require_approval policy, so publish_article,
#      unpublish_article and delete_article are ASK FIRST;
#   4. verify: the policy engine answers require_approval for those three and
#      allows the reads; when the company has a recent run, a real site_info
#      call returns that company's own blog.
#
# Isolation is structural: each tool call reads only the calling company's
# config, so a company's agents can reach only its own blog. Reaching the
# private in-cluster hosts needs PAPERCLIP_PLUGIN_HTTP_ALLOWED_PRIVATE_HOSTS
# (bionic-org chart value `plugins.ghostBlog.allowedPrivateHosts`).
#
# Requires: curl jq kubectl; env VAULT_TOKEN; PAPERCLIP_BOARD_KEY_FILE (0600,
# instance-admin board key). No secret ever appears on a command line.
#
# Usage: deploy/scripts/setup-ghost-plugin.sh [--rotate] [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
PLUGIN_KEY="paperclip.ghost-blog"
PLUGIN_PATH="${GHOST_PLUGIN_PATH:-/app/packages/plugins/plugin-ghost-blog}"
SECRET_KEY="ghost_admin_api_key"
POLICY_NAME="Ghost blog plugin: ask first"
ASK_FIRST=(publish_article unpublish_article delete_article)
READS=(site_info list_articles get_article list_tags)
# site|company-name prefix|siteUrl|publicUrl|siteName
SITES=(
  "bionic|Bionic AI Solutions|http://ghost-bionic.blog.svc.cluster.local:2368|https://blog-bionic.baisoln.com|Bionic AI Solutions"
  "reliora|Reliora|http://ghost-reliora.blog.svc.cluster.local:2368|https://blog-reliora.baisoln.com|Reliora Inc"
)
ROTATE=0; DRY=0
for a in "$@"; do
  case "$a" in
    --rotate) ROTATE=1 ;; --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[ghost-plugin] $*"; }
for b in curl jq kubectl; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -n "${VAULT_TOKEN:-}" ]] || die "VAULT_TOKEN is not set"
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"
W="$(mktemp -d)"; chmod 700 "$W"; trap 'rm -rf "$W"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$W/auth"

api() {  # api METHOD PATH [json-file] -> body; non-2xx fatal
  local code
  code="$(curl -sS -o "$W/resp" -w '%{http_code}' -X "$1" -H @"$W/auth" -H 'Content-Type: application/json' \
    -H 'User-Agent: paperclip-ghost-plugin-setup/1' ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" \
    || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$W/resp")"
  cat "$W/resp"
}
list() { jq -c "if type==\"array\" then . else (.$1 // .items // []) end"; }
vault_get() {
  local v
  v="$(printf '%s\n' "$VAULT_TOKEN" | timeout 60 kubectl exec -i -n vault vault-0 -- sh -c \
    'read -r VAULT_TOKEN; export VAULT_TOKEN VAULT_ADDR=http://127.0.0.1:8200; vault kv get -field="$2" "secret/$1"' _ "$1" "$2")" \
    || die "cannot read Vault $1:$2"
  [[ -n "$v" ]] || die "Vault $1:$2 is empty"
  printf '%s' "$v"
}

companies="$(api GET /companies | list companies | jq '[.[] | select((.status // "active") != "archived")]')"
log "board key sees $(jq length <<<"$companies") active companies"

# 1. Install once.
plugin="$(api GET /plugins | list plugins | jq -c --arg k "$PLUGIN_KEY" '[.[] | select(.pluginKey==$k)] | .[0] // empty')"
if [[ -z "$plugin" ]]; then
  [[ $DRY -eq 1 ]] && { log "dry-run: would install $PLUGIN_KEY from $PLUGIN_PATH"; exit 0; }
  jq -n --arg p "$PLUGIN_PATH" '{packageName:$p, isLocalPath:true}' > "$W/install.json"
  api POST /plugins/install "$W/install.json" >/dev/null
  plugin="$(api GET /plugins | list plugins | jq -c --arg k "$PLUGIN_KEY" '[.[] | select(.pluginKey==$k)] | .[0] // empty')"
  [[ -n "$plugin" ]] || die "plugin did not appear after install"
  log "installed $PLUGIN_KEY"
fi
pid="$(jq -r .id <<<"$plugin")"; status="$(jq -r .status <<<"$plugin")"
if [[ "$status" != "ready" && "$status" != "enabled" && "$status" != "active" ]]; then
  log "plugin status '$status'; enabling"
  api POST "/plugins/$pid/enable" >/dev/null
fi
tools_json="$(printf '%s\n' "${ASK_FIRST[@]}" | jq -R --arg k "$PLUGIN_KEY" '"\($k):\(.)"' | jq -s .)"

for entry in "${SITES[@]}"; do
  IFS='|' read -r site match site_url public_url site_name <<<"$entry"
  cid="$(jq -r --arg m "$match" '[.[] | select((.name|ascii_downcase)|startswith($m|ascii_downcase))] |
          if length==1 then .[0].id else "MULTI:\(length)" end' <<<"$companies")"
  [[ "$cid" != MULTI:* ]] || die "company match '$match' found ${cid#MULTI:} active companies (need exactly 1)"
  log "$site -> company $(jq -r --arg id "$cid" '.[]|select(.id==$id)|.name' <<<"$companies") ($cid)"
  [[ $DRY -eq 1 ]] && continue

  # 2a. The company's own secret.
  sec="$(api GET "/companies/$cid/secrets" | list secrets | jq -c --arg k "$SECRET_KEY" '[.[] | select(.key==$k)] | .[0] // empty')"
  if [[ -z "$sec" || $ROTATE -eq 1 ]]; then
    key="$(vault_get t6-apps/ghost/config "${site}_admin_api_key")"
    if [[ -z "$sec" ]]; then
      GHOST_KEY="$key" jq -n --arg k "$SECRET_KEY" --arg n "Ghost Admin API key ($site_name)" \
        '{name:$n, key:$k, value:env.GHOST_KEY, description:"Ghost Blog plugin: this company'"'"'s Admin API key"}' > "$W/sec.json"
      sec="$(api POST "/companies/$cid/secrets" "$W/sec.json")"
      log "  secret created"
    else
      GHOST_KEY="$key" jq -n '{value:env.GHOST_KEY}' > "$W/sec.json"
      api POST "/secrets/$(jq -r .id <<<"$sec")/rotate" "$W/sec.json" >/dev/null
      log "  secret rotated to the current Vault value"
    fi
    unset key; rm -f "$W/sec.json"
  fi
  sid="$(jq -r .id <<<"$sec")"

  # 2b. The company's config (only this company's site and secret).
  jq -n --arg c "$cid" --arg u "$site_url" --arg p "$public_url" --arg n "$site_name" --arg s "$sid" \
    '{companyId:$c, configJson:{siteUrl:$u, publicUrl:$p, siteName:$n, adminApiKey:{type:"secret_ref", secretId:$s}}}' > "$W/cfg.json"
  api POST "/plugins/$pid/config" "$W/cfg.json" >/dev/null
  log "  config saved (siteUrl $site_url)"

  # 3. Ask-first policy.
  have="$(api GET "/companies/$cid/tools/policies" | list policies | jq -r --arg n "$POLICY_NAME" '[.[] | select(.name==$n)] | length')"
  if [[ "$have" -eq 0 ]]; then
    jq -n --arg n "$POLICY_NAME" --argjson t "$tools_json" \
      '{name:$n, description:"Publishing, unpublishing and deleting blog articles need a board approval.",
        policyType:"require_approval", priority:50, enabled:true, selectors:{toolNames:$t}}' > "$W/pol.json"
    api POST "/companies/$cid/tools/policies" "$W/pol.json" >/dev/null
    log "  ask-first policy created"
  fi

  # 4. Verify with the policy engine (same decision path agents hit).
  agent="$(api GET "/companies/$cid/agents" | list agents | jq -r '[.[] | select(.status as $s | ["active","idle","running","paused","error"] | index($s))][0].id // empty')"
  [[ -n "$agent" ]] || die "no assignable agent in company $cid to verify with"
  decide() {
    jq -n --arg c "$cid" --arg a "$agent" --arg t "$PLUGIN_KEY:$1" \
      '{companyId:$c, actor:{actorType:"agent", actorId:$a, agentId:$a}, request:{toolName:$t, sideEffecting:true}}' > "$W/dec.json"
    api POST "/companies/$cid/tools/policy/test" "$W/dec.json" | jq -r '.decision.decision // .decision'
  }
  for t in "${ASK_FIRST[@]}"; do
    d="$(decide "$t")"; [[ "$d" == require_approval ]] || die "$site: $t decides '$d', expected require_approval"
  done
  for t in "${READS[@]}"; do
    d="$(decide "$t")"; [[ "$d" == allow* ]] || die "$site: $t decides '$d', expected allow"
  done
  log "  policy verified: ${ASK_FIRST[*]} ask first; reads allowed"

  # Real call through the plugin when the company has a run to attach to.
  run="$(api GET "/companies/$cid/heartbeat-runs?limit=50" | list runs | jq -r --arg a "$agent" '[.[] | select(.agentId==$a)][0].id // empty')"
  project="$(api GET "/companies/$cid/projects" | list projects | jq -r '.[0].id // empty')"
  if [[ -n "$run" && -n "$project" ]]; then
    jq -n --arg t "$PLUGIN_KEY:site_info" --arg a "$agent" --arg r "$run" --arg c "$cid" --arg p "$project" \
      '{tool:$t, parameters:{}, runContext:{agentId:$a, runId:$r, companyId:$c, projectId:$p}}' > "$W/exec.json"
    out="$(api POST /plugins/tools/execute "$W/exec.json")"
    url="$(jq -r '.result.data.url // .data.url // empty' <<<"$out")"
    [[ "$url" == "$public_url/" || "$url" == "$public_url" ]] || die "$site: site_info returned '${url:-?}', expected $public_url: $(head -c 300 <<<"$out")"
    log "  verified: a real site_info call returns $url"
  else
    log "  (no run/project in this company yet: real call skipped; policy verified)"
  fi
done
log "done"
