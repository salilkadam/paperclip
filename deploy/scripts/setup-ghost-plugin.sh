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
#   3. per company: a tool profile "Ghost blog (plugin)" that includes exactly
#      the plugin's tools, bound to the company (all its agents);
#   4. verify: the policy engine allows each tool for an agent of the company,
#      and a real site_info call returns that company's own blog. If no run
#      exists to make that call, the script exits 3 ("configured, not verified").
#
# DRAFTS ONLY: the plugin has no publish/unpublish/delete tools (Paperclip
# cannot execute an approved plugin action after the fact). Publishing is
# done in Ghost admin or through the per-company Ghost blog MCP connection,
# whose ask-first approvals do run.
#
# Isolation is structural: each tool call reads only the calling company's
# config, so a company's agents can reach only its own blog. Reaching the
# private in-cluster hosts needs PAPERCLIP_PLUGIN_HTTP_ALLOWED_PRIVATE_HOSTS
# (bionic-org chart value `plugins.ghostBlog.allowedPrivateHosts`).
#
# Requires: curl jq kubectl; kubeconfig (Vault access via lib/vault-ops.sh, no static token); PAPERCLIP_BOARD_KEY_FILE (0600,
# instance-admin board key). No secret ever appears on a command line.
#
# Usage: deploy/scripts/setup-ghost-plugin.sh [--rotate] [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
PLUGIN_KEY="paperclip.ghost-blog"
PLUGIN_PATH="${GHOST_PLUGIN_PATH:-/app/packages/plugins/plugin-ghost-blog}"
SECRET_KEY="ghost_admin_api_key"
PROFILE_KEY="ghost-blog-plugin"
PROFILE_NAME="Ghost blog (plugin)"
TOOLS=(site_info list_articles get_article create_draft update_article list_tags)
UNVERIFIED=0
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
# shellcheck source=lib/vault-ops.sh
source "$(cd "$(dirname "$0")" && pwd)/lib/vault-ops.sh"
vault_ops_login   # short-lived Vault token via the bionic-org-ops ServiceAccount
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"
W="$(mktemp -d)"; chmod 700 "$W"; trap 'rm -rf "$W"; vault_ops_logout' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$W/auth"

api() {  # api METHOD PATH [json-file] -> body; non-2xx fatal
  local code
  code="$(curl -sS -o "$W/resp" -w '%{http_code}' -X "$1" -H @"$W/auth" -H 'Content-Type: application/json' \
    -H 'User-Agent: paperclip-ghost-plugin-setup/1' ${3:+--data-binary @"$3"} --max-time "${API_MAX_TIME:-120}" "$API/api$2")" \
    || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$W/resp")"
  cat "$W/resp"
}
list() { jq -c "if type==\"array\" then . else (.$1 // .items // []) end"; }
vault_get() { vault_ops_get "$@"; }  # absent, unreadable or empty is fatal

companies="$(api GET /companies | list companies | jq '[.[] | select((.status // "active") != "archived")]')"
log "board key sees $(jq length <<<"$companies") active companies"

# 1. Install once.
find_plugin() { api GET /plugins | list plugins | jq -c --arg k "$PLUGIN_KEY" '[.[] | select(.pluginKey==$k and .status!="uninstalled")] | .[0] // empty'; }
plugin="$(find_plugin)"
if [[ -z "$plugin" ]]; then
  [[ $DRY -eq 1 ]] && { log "dry-run: would install $PLUGIN_KEY from $PLUGIN_PATH"; exit 0; }
  jq -n --arg p "$PLUGIN_PATH" '{packageName:$p, isLocalPath:true}' > "$W/install.json"
  api POST /plugins/install "$W/install.json" >/dev/null
  plugin="$(find_plugin)"
  [[ -n "$plugin" ]] || die "plugin did not appear after install"
  log "installed $PLUGIN_KEY"
fi
pid="$(jq -r .id <<<"$plugin")"; status="$(jq -r .status <<<"$plugin")"
if [[ "$status" != "ready" && "$status" != "enabled" && "$status" != "active" ]]; then
  log "plugin status '$status'; enabling"
  api POST "/plugins/$pid/enable" >/dev/null
fi
tools_json="$(printf '%s\n' "${TOOLS[@]}" | jq -R --arg k "$PLUGIN_KEY" '"\($k):\(.)"' | jq -s .)"

for entry in "${SITES[@]}"; do
  IFS='|' read -r site match site_url public_url site_name <<<"$entry"
  cid="$(jq -r --arg m "$match" '[.[] | select((.name|ascii_downcase)|startswith($m|ascii_downcase))] |
          if length==1 then .[0].id else "MULTI:\(length)" end' <<<"$companies")"
  [[ "$cid" != MULTI:* ]] || die "company match '$match' found ${cid#MULTI:} active companies (need exactly 1)"
  log "$site -> company $(jq -r --arg id "$cid" '.[]|select(.id==$id)|.name' <<<"$companies") ($cid)"
  [[ $DRY -eq 1 ]] && continue

  # 2a. The company's own secret.
  sec="$(api GET "/companies/$cid/secrets" | list secrets | jq -c --arg k "$SECRET_KEY" '[.[] | select(.key==$k and ((.status // "active") | IN("active","enabled")))] | .[0] // empty')"
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

  # 3. Access: a profile with exactly the plugin's tools, bound to the company
  #    AND to each current agent. Paperclip applies only the NARROWEST bound
  #    scope (agent beats project beats company), so an agent with its own
  #    profile would otherwise lose a company-only grant. Agents added later
  #    get the company binding; re-run this script to give them the agent one.
  agents_json="$(api GET "/companies/$cid/agents" | list agents | jq -c '[.[] | select(.status as $s | ["active","idle","running","paused","error"] | index($s)) | .id]')"
  [[ "$(jq length <<<"$agents_json")" -gt 0 ]] || die "no assignable agent in company $cid"
  prof="$(api GET "/companies/$cid/tools/profiles" | list profiles | jq -c --arg k "$PROFILE_KEY" '[.[] | select(.profileKey==$k)] | .[0] // empty')"
  if [[ -z "$prof" ]]; then
    jq -n --arg k "$PROFILE_KEY" --arg n "$PROFILE_NAME" --argjson t "$tools_json" \
      '{profileKey:$k, name:$n, description:"Ghost Blog plugin tools (drafts only) for this company'"'"'s own blog.",
        defaultAction:"deny", entries:[$t[] | {selectorType:"tool_name", effect:"include", toolName:.}]}' > "$W/prof.json"
    prof="$(api POST "/companies/$cid/tools/profiles" "$W/prof.json")"
    log "  profile created"
  fi
  prof_id="$(jq -r '.id // .profile.id' <<<"$prof")"
  [[ "$(jq -r '.status // "active"' <<<"$prof")" == active ]] || die "$site: profile $PROFILE_KEY exists but is $(jq -r .status <<<"$prof"); reactivate or remove it"
  bind() {  # bind <targetType> <targetId>; an existing identical binding is fine
    local code
    jq -n --arg t "$1" --arg i "$2" '{targetType:$t, targetId:$i}' > "$W/bind.json"
    code="$(curl -sS -o "$W/resp" -w '%{http_code}' -X POST -H @"$W/auth" -H 'Content-Type: application/json' \
      --data-binary @"$W/bind.json" --max-time 60 "$API/api/companies/$cid/tools/profiles/$prof_id/bind")" || die "bind $1 $2: transport error"
    [[ "$code" =~ ^2 || "$code" == 409 ]] || die "bind $1 $2 -> HTTP $code: $(head -c 300 "$W/resp")"
  }
  bind company "$cid"
  for a in $(jq -r '.[]' <<<"$agents_json"); do bind agent "$a"; done
  log "  profile bound to the company and $(jq length <<<"$agents_json") agent(s)"

  # A company policy is evaluated BEFORE profiles and can match on provider
  # type or risk level, which policy/test cannot express. Refuse to report
  # success if an enabled block/approval policy could catch these tools
  # (an approved plugin action cannot run, so require_approval = never runs).
  clash="$(api GET "/companies/$cid/tools/policies" | list policies | jq -r --argjson t "$tools_json" '
    [.[] | select(.enabled != false and (.policyType == "block" or .policyType == "require_approval"))
         | select(
             (.selectors // {}) as $s
             | ($s | length) == 0
               or ([($s.providerType // empty), ($s.providerTypes // [])[]?] | any(. == "paperclip_plugin"))
               or ([($s.riskLevel // empty), ($s.riskLevels // [])[]?] | any(. == "read" or . == "write"))
               or ([($s.toolName // empty), ($s.toolNames // [])[]?] | any(. as $n | $t | index($n))))
         | .name] | join(", ")')"
  [[ -z "$clash" ]] || die "$site: company policies that would block or hold these plugin tools: $clash"

  # 4. Verify every agent: the plugin tools are effectively allowed for it.
  for a in $(jq -r '.[]' <<<"$agents_json"); do
    # Large companies return a big effective view; it has taken >120s once.
    eff="$(API_MAX_TIME=300 api GET "/companies/$cid/tools/profiles/effective/agents/$a")"
    missing="$(jq -r --argjson t "$tools_json" '[$t[] as $n | select((.allowedToolNames // []) | index($n) | not) | $n] | join(", ")' <<<"$eff")"
    [[ -z "$missing" ]] || die "$site: agent $a is not allowed: $missing (a narrower profile or binding may shadow the company grant)"
    jq -n --arg c "$cid" --arg a "$a" --arg t "$PLUGIN_KEY:site_info" \
      '{companyId:$c, actor:{actorType:"agent", actorId:$a, agentId:$a}, request:{toolName:$t}}' > "$W/dec.json"
    d="$(api POST "/companies/$cid/tools/policy/test" "$W/dec.json" | jq -r '.decision.decision // .decision')"
    [[ "$d" == allow* ]] || die "$site: policy engine decides '$d' for agent $a"
  done
  agent="$(jq -r '.[0]' <<<"$agents_json")"
  log "  access verified for every agent: ${TOOLS[*]}"

  # The real call below uses the board path (plugin, config, secret, network);
  # agent authorization is what the checks above verify.
  # Real call through the plugin when the company has a run to attach to.
  # Any recent run of any of this company's agents will do (the first agent
  # may never have run); the call is made as that run's agent.
  run_pair="$(api GET "/companies/$cid/heartbeat-runs?limit=50" | list runs | jq -r --argjson ids "$agents_json" '[.[] | select(.agentId as $x | $ids | index($x))][0] | if . then "\(.id) \(.agentId)" else "" end')"
  run="${run_pair%% *}"; [[ -n "$run_pair" ]] && agent="${run_pair##* }"
  project="$(api GET "/companies/$cid/projects" | list projects | jq -r '.[0].id // empty')"
  if [[ -n "$run" && -n "$project" ]]; then
    jq -n --arg t "$PLUGIN_KEY:site_info" --arg a "$agent" --arg r "$run" --arg c "$cid" --arg p "$project" \
      '{tool:$t, parameters:{}, runContext:{agentId:$a, runId:$r, companyId:$c, projectId:$p}}' > "$W/exec.json"
    out="$(api POST /plugins/tools/execute "$W/exec.json")"
    url="$(jq -r '.result.data.url // .data.url // empty' <<<"$out")"
    [[ "$url" == "$public_url/" || "$url" == "$public_url" ]] || die "$site: site_info returned '${url:-?}', expected $public_url: $(head -c 300 <<<"$out")"
    log "  verified: a real site_info call returns $url"
  else
    log "  NOT VERIFIED: no run/project in this company yet, so no real call was made"
    UNVERIFIED=1
  fi
done
if [[ $UNVERIFIED -eq 1 ]]; then
  log "done: configured, but at least one company could not be verified with a real call (exit 3)"
  exit 3
fi
log "done"
