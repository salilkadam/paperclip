#!/bin/sh
# deployer.sh STEP — one step of the Reliora website deployer.
# Plan: doc/plans/2026-11-02-reliora-site-deployer.md. Each step runs in its own
# container with only the mounts it needs (see deploy/reliora-website/50-cronjob.yaml).
#
# Rules this script keeps:
# - Every step exits 0 and records its outcome, except `report`, which sets the
#   Job's exit code. So the state, the heartbeat and the Lease release happen.
# - Trusted steps never read what commit code wrote, except the one-word results
#   in /checkout/result and /stageout/result, read with read_word.
# - Every value written to a file, the ConfigMap or Slack is validated first.
set -u
STEP="${1:?step}"
SITE=/srv/site
TRUSTED=/trusted
NS="${NAMESPACE:-reliora-website}"
REPO_URL="${REPO_URL:-git@github.com:Reliora-Inc/reliora-website.git}"
ME="${POD_NAME:-local}"
HEX40='^[0-9a-f]\{40\}$'
HEX64='^[0-9a-f]\{64\}$'
LEASE_STALE=900          # seconds; above the longest gap between renewals
now() { date +%s; }
log() { echo "[$STEP] $*"; }

# The deployer's own version: a hash of its scripts. A commit pinned as failed
# is retried when this changes (a deployer-side fix needs no site commit).
deployer_version() { cat /scripts/deployer.sh /scripts/smoke.sh /scripts/stage-top.conf 2>/dev/null | sha256sum | cut -c1-64; }

# outcome STATUS REASON: record this step's outcome for later trusted steps.
outcome() {
  mkdir -p "$TRUSTED/status"
  printf '%s %s\n' "$1" "$2" > "$TRUSTED/status/.$STEP"
  mv -f "$TRUSTED/status/.$STEP" "$TRUSTED/status/$STEP"
  log "outcome: $1 $2"
}
status_of() { [ -f "$TRUSTED/status/$1" ] && cut -d' ' -f1 "$TRUSTED/status/$1" || echo none; }
plan_action() { [ -f "$TRUSTED/plan" ] && head -c 16 "$TRUSTED/plan" | tr -dc 'a-z' || echo none; }
sha() { s="$(head -c 40 "$TRUSTED/sha" 2>/dev/null)"; echo "$s" | grep -q "$HEX40" && echo "$s"; }

# read_word FILE: one lowercase word from a file commit code may have written.
# Must be a regular file (not a symlink, FIFO or device); at most 8 bytes read;
# never copied anywhere, only compared.
read_word() {
  [ -f "$1" ] && [ ! -L "$1" ] || { echo invalid; return; }
  w="$(head -c 8 "$1" | tr -dc 'a-z')"
  case "$w" in pass|fail|timeout|conf) echo "$w" ;; *) echo invalid ;; esac
}

# --- state file on the volume: key=value lines, written atomically ----------
state_get() { [ -f "$SITE/state" ] && grep "^$1=" "$SITE/state" | head -1 | cut -d= -f2- | tr -dc 'a-z0-9_' || true; }
state_put() { # state_put state reason commit previous prevhash tries
  st="$1"; rs="$2"; cm="$3"; pv="$4"; ph="$5"; tr="$6"
  echo "$st" | grep -q '^[a-z_]\{1,24\}$' || st=invalid
  echo "$rs" | grep -q '^[a-z0-9_]\{1,40\}$' || rs=invalid
  echo "$cm" | grep -q "$HEX40" || cm=none
  echo "$pv" | grep -q "$HEX40" || pv=none
  echo "$ph" | grep -q "$HEX64" || ph=none
  echo "$tr" | grep -q '^[0-9]\{1,4\}$' || tr=0
  printf 'state=%s\nreason=%s\ncommit=%s\ndeployer=%s\nprevious=%s\nprevhash=%s\ntries=%s\ntime=%s\n' \
    "$st" "$rs" "$cm" "$(deployer_version)" "$pv" "$ph" "$tr" "$(now)" > "$SITE/.state.tmp" &&
    mv -f "$SITE/.state.tmp" "$SITE/state"
}
current_sha() { l="$(readlink "$SITE/current" 2>/dev/null)"; s="${l##*/}"; echo "$s" | grep -q "$HEX40" && echo "$s" || true; }

# --- Lease (steps holding the token) --------------------------------------
lease_json() { kubectl -n "$NS" get lease site-deployer -o json; }
lease_take() { # replace with our holder, only if the resourceVersion is unchanged
  echo "$1" | jq --arg me "$ME" --arg t "$(date -u +%Y-%m-%dT%H:%M:%S.000000Z)" \
    '.spec.holderIdentity=$me | .spec.renewTime=$t | .spec.acquireTime=$t | .spec.leaseDurationSeconds='"$LEASE_STALE" \
    | kubectl replace -f - >/dev/null 2>&1
}
lease_mine() { [ "$(lease_json 2>/dev/null | jq -r '.spec.holderIdentity // ""')" = "$ME" ]; }
lease_renew() { j="$(lease_json 2>/dev/null)" || return 1
  [ "$(echo "$j" | jq -r '.spec.holderIdentity // ""')" = "$ME" ] || return 1
  lease_take "$j"; }
renew_loop() { ( while sleep 30; do lease_renew || exit 0; done ) & RENEW_PID=$!; }
fence() { lease_mine || { log "lost the Lease; stopping"; outcome infra_error lost_lease; exit 0; }; }

# --- steps ----------------------------------------------------------------
step_lock() {
  j="$(lease_json)" || { outcome infra_error lease_read; return; }
  holder="$(echo "$j" | jq -r '.spec.holderIdentity // ""')"
  renew="$(echo "$j" | jq -r '.spec.renewTime // ""')"
  age=999999
  if [ -n "$renew" ]; then age=$(( $(now) - $(date -d "$(echo "$renew" | cut -c1-19 | tr T ' ')" +%s 2>/dev/null || echo 0) )); fi
  takeable=no
  if [ -z "$holder" ] || [ "$holder" = "$ME" ] || [ "$age" -gt "$LEASE_STALE" ]; then takeable=yes
  else
    phase="$(kubectl -n "$NS" get pod "$holder" -o jsonpath='{.status.phase}' 2>/dev/null || echo gone)"
    case "$phase" in Running|Pending) ;; *) takeable=yes ;; esac
  fi
  [ "$takeable" = yes ] || { outcome skip locked; return; }
  lease_take "$j" && lease_mine && outcome ok locked_by_me || outcome skip lock_race
}

step_fetch() {
  [ "$(status_of lock)" = ok ] || { echo skip > "$TRUSTED/plan"; outcome skip not_locked; return; }
  install -m 600 /git-key/deploy_key /tmp/deploy_key 2>/dev/null || { echo skip > "$TRUSTED/plan"; outcome infra_error no_key; return; }
  export GIT_SSH_COMMAND="ssh -i /tmp/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=/scripts/known_hosts -o StrictHostKeyChecking=yes"
  head="$(timeout 60 git ls-remote "$REPO_URL" refs/heads/main 2>/dev/null | cut -f1)"
  echo "$head" | grep -q "$HEX40" || { echo skip > "$TRUSTED/plan"; outcome infra_error ls_remote; return; }
  st="$(state_get state)"; cm="$(state_get commit)"; dv="$(state_get deployer)"; tries="$(state_get tries)"; t="$(state_get time)"
  mine="$(deployer_version)"
  case "$st" in
    staging|switching|restarting|rolling_back)
      echo "$cm" > "$TRUSTED/sha"; echo recover > "$TRUSTED/plan"; outcome ok "recover_$st"; return ;;
  esac
  if [ "$cm" = "$head" ] && [ "$dv" = "$mine" ]; then
    case "$st" in
      ok|published) [ "$(current_sha)" = "$head" ] && { echo skip > "$TRUSTED/plan"; outcome skip up_to_date; return; } ;;
      failed_check|failed_smoke|failed_timeout|broken) echo skip > "$TRUSTED/plan"; outcome skip "pinned_$st"; return ;;
      infra_error)
        n="${tries:-1}"; [ "$n" -gt 5 ] && n=5
        wait=$(( 120 * (1 << (n - 1)) )); [ "$n" -ge 5 ] && wait=3600
        [ $(( $(now) - ${t:-0} )) -ge "$wait" ] || { echo skip > "$TRUSTED/plan"; outcome skip backoff; return; } ;;
    esac
  fi
  rm -rf "$TRUSTED/src" /checkin/src
  mkdir -p "$TRUSTED/src" && cd "$TRUSTED/src" && git init -q &&
    timeout 120 git fetch -q --depth 1 "$REPO_URL" "$head" && git checkout -q FETCH_HEAD &&
    [ "$(git rev-parse HEAD)" = "$head" ] || { echo skip > "$TRUSTED/plan"; outcome infra_error clone; return; }
  rm -rf .git
  cp -a "$TRUSTED/src" /checkin/src || { echo skip > "$TRUSTED/plan"; outcome infra_error copy_checkin; return; }
  echo "$head" > "$TRUSTED/sha"; echo deploy > "$TRUSTED/plan"
  outcome ok "deploy"
}

step_attempt() { # count attempts per commit+deployer before any untrusted work
  a="$(plan_action)"; [ "$a" = deploy ] || [ "$a" = recover ] || { outcome skip "$a"; return; }
  s="$(sha)"; [ -n "$s" ] || { outcome skip no_sha; return; }
  key="$s-$(deployer_version | cut -c1-12)"
  cm="$(kubectl -n "$NS" get configmap site-deploy-state -o json)" || { outcome infra_error cm_read; return; }
  prev="$(echo "$cm" | jq -r '.data["attempt-key"] // ""')"; n="$(echo "$cm" | jq -r '.data["attempt-count"] // "0"' | tr -dc 0-9)"
  [ "$prev" = "$key" ] && n=$(( ${n:-0} + 1 )) || n=1
  kubectl -n "$NS" patch configmap site-deploy-state --type merge \
    -p "{\"data\":{\"attempt-key\":\"$key\",\"attempt-count\":\"$n\"}}" >/dev/null || { outcome infra_error cm_patch; return; }
  if [ "$n" -gt 3 ]; then echo skip > "$TRUSTED/plan"; outcome failed_timeout "attempts_$n"; return; fi
  outcome ok "attempt_$n"
}

step_check() { # commit code; mounts /checkin and /checkout only; writes one word
  rm -f /checkout/result
  [ -d /checkin/src ] || { echo skip > /checkout/result; return 0; }
  cd /checkin/src && timeout 300 node site-src/build.cjs --check > /dev/null 2>&1; rc=$?
  case "$rc" in 0) w=pass ;; 124|137|143) w=timeout ;; *) w=fail ;; esac
  echo "$w" > /checkout/result 2>/dev/null || true
  echo "[check] $w"
  return 0
}

count_of() { grep -oF -- "$2" "$1" | wc -l | tr -d ' '; }
render() { # render SRC DEST ROOT LISTEN: exact substitutions, fail closed on counts
  [ "$(count_of "$1" '/usr/share/nginx/html')" = 2 ] &&
  [ "$(count_of "$1" '/etc/nginx/snippets/security-headers.conf')" = 5 ] &&
  [ "$(count_of "$1" 'listen 8080;')" = 1 ] || return 1
  sed -e "s#/usr/share/nginx/html#$3/html#g" \
      -e "s#/etc/nginx/snippets/security-headers.conf#$3/security-headers.conf#g" \
      -e "s#listen 8080;#$4#" "$1" > "$2"
}

step_copy() { # PVC read-write; runs no commit code
  a="$(plan_action)"; [ "$a" = deploy ] || { outcome skip "$a"; return; }
  [ "$(status_of attempt)" = ok ] || { outcome skip attempt_not_ok; return; }
  s="$(sha)"; [ -n "$s" ] || { outcome infra_error no_sha; return; }
  pv="$(current_sha)"; ph=none; [ -n "$pv" ] && ph="$(head -c 64 "$SITE/releases/$pv/config.hash" 2>/dev/null)"
  case "$(read_word /checkout/result)" in
    pass) ;;
    timeout) state_put failed_timeout check_timeout "$s" "$pv" "$ph" 0; outcome failed_timeout check; return ;;
    *) state_put failed_check check_failed "$s" "$pv" "$ph" 0; outcome failed_check check; return ;;
  esac
  src="$TRUSTED/src"
  for f in deploy/nginx.conf deploy/security-headers.conf; do
    [ -f "$src/$f" ] && [ ! -L "$src/$f" ] || { state_put failed_check bad_config_file "$s" "$pv" "$ph" 0; outcome failed_check config_file; return; }
  done
  if [ -n "$(find "$src/public" \( -type l -o \( ! -type f ! -type d \) \) -print | head -1)" ]; then
    state_put failed_check special_file "$s" "$pv" "$ph" 0; outcome failed_check special_file; return; fi
  if [ -n "$(find "$src/public" -type f -size +51200k -print | head -1)" ] ||
     [ "$(du -sk "$src/public" | cut -f1)" -gt 512000 ]; then
    state_put failed_check too_large "$s" "$pv" "$ph" 0; outcome failed_check too_large; return; fi
  rel="$SITE/releases/$s"
  if [ -f "$rel/.complete" ]; then outcome ok reuse; state_put staging staged "$s" "$pv" "$ph" 0; return; fi
  tmp="$SITE/releases/.tmp-$s"; rm -rf "$tmp" "$rel"
  { mkdir -p "$tmp" && cp -R "$src/public" "$tmp/html" &&
    cp "$src/deploy/security-headers.conf" "$tmp/security-headers.conf"; } ||
    { rm -rf "$tmp"; state_put infra_error copy_io "$s" "$pv" "$ph" "$(( $(state_get tries | tr -dc 0-9) + 1 ))"; outcome infra_error copy_io; return; }
  render "$src/deploy/nginx.conf" "$tmp/default.conf" "$SITE/current" 'listen 8080;' &&
  render "$src/deploy/nginx.conf" "$tmp/staging.conf" "$rel" 'listen 127.0.0.1:8081;' ||
    { rm -rf "$tmp"; state_put failed_check config_anchors "$s" "$pv" "$ph" 0; outcome failed_check config_anchors; return; }
  cat "$tmp/default.conf" "$tmp/security-headers.conf" | sha256sum | cut -c1-64 > "$tmp/config.hash"
  touch "$tmp/.complete" && mv "$tmp" "$rel" ||
    { state_put infra_error rename "$s" "$pv" "$ph" 1; outcome infra_error rename; return; }
  state_put staging staged "$s" "$pv" "$ph" 0
  outcome ok staged
}

step_stage() { # PVC read-only; runs the commit's nginx config; writes one word
  rm -f /stageout/result
  [ "$(plan_action)" = deploy ] && [ "$(status_of copy)" = ok ] || { echo skip > /stageout/result; return 0; }
  s="$(sha)"; [ -n "$s" ] || { echo fail > /stageout/result; return 0; }
  sed "s#__RELEASE__#$SITE/releases/$s#" /scripts/stage-top.conf > /stagetmp/top.conf
  if ! timeout 30 nginx -t -c /stagetmp/top.conf >/stagetmp/nginx-t.log 2>&1; then echo conf > /stageout/result; echo "[stage] conf"; return 0; fi
  timeout 30 nginx -c /stagetmp/top.conf || { echo conf > /stageout/result; return 0; }
  sleep 1
  TMPDIR=/stagetmp timeout 200 sh /scripts/smoke.sh http://127.0.0.1:8081 "$SITE/releases/$s/html/sitemap.xml"; rc=$?
  nginx -c /stagetmp/top.conf -s stop >/dev/null 2>&1 || true
  case "$rc" in 0) w=pass ;; 124|137|143) w=timeout ;; *) w=fail ;; esac
  echo "$w" > /stageout/result; echo "[stage] $w"; return 0
}

# pods_smoke SHA: smoke each serving, non-terminating website pod
pods_smoke() {
  ips="$(kubectl -n "$NS" get endpointslices -l kubernetes.io/service-name=reliora-website -o json |
    jq -r '.items[].endpoints[]? | select(.conditions.serving==true and .conditions.terminating!=true) | .addresses[0]' | sort -u)"
  [ -n "$ips" ] || { log "no serving pods"; return 1; }
  for ip in $ips; do
    echo "$ip" | grep -q '^[0-9.]\{7,15\}$' || return 1
    timeout 200 sh /scripts/smoke.sh "http://$ip:8080" "$SITE/releases/$1/html/sitemap.xml" > /tmp/smoke.log 2>&1 || { log "smoke failed on $ip"; tail -5 /tmp/smoke.log; return 1; }
  done
}
template_hash() { kubectl -n "$NS" get deploy reliora-website -o jsonpath='{.spec.template.metadata.annotations.reliora\.ai/config-hash}'; }
serving_mode() { kubectl -n "$NS" get deploy reliora-website -o jsonpath='{.metadata.annotations.reliora\.ai/serving}'; }
set_hash() { # set_hash HASH: restart pods onto that config, wait for the rollout
  fence
  kubectl -n "$NS" patch deploy reliora-website --type merge \
    -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"reliora.ai/config-hash\":\"$1\"}}}}}" >/dev/null &&
  kubectl -n "$NS" rollout status deploy/reliora-website --timeout=240s >/dev/null
}
point_to() { fence; ln -sfn "releases/$1" "$SITE/.current.new" && mv -T "$SITE/.current.new" "$SITE/current"; }
hash_of() { head -c 64 "$SITE/releases/$1/config.hash" 2>/dev/null; }

go_live_check() { # go_live_check SHA: config hash, then each pod
  h="$(hash_of "$1")"
  if [ "$(template_hash)" != "$h" ]; then
    state_put restarting config_changed "$1" "$PV" "$PH" 0
    set_hash "$h" || return 1
  fi
  pods_smoke "$1"
}
rollback() { # rollback SHA reason
  state_put rolling_back "$2" "$1" "$PV" "$PH" 0
  if [ -z "$PV" ] || [ ! -f "$SITE/releases/$PV/.complete" ]; then state_put broken no_previous "$1" none none 0; outcome broken no_previous; return; fi
  point_to "$PV"
  if [ "$(template_hash)" != "$PH" ]; then set_hash "$PH" || true; fi
  if pods_smoke "$PV"; then state_put failed_smoke "$2" "$1" "$PV" "$PH" 0; outcome failed_smoke "$2"
  else state_put broken "$2" "$1" "$PV" "$PH" 0; outcome broken "$2"; fi
}

step_switch() { # token, PVC read-write
  a="$(plan_action)"; s="$(sha)"
  [ "$a" = deploy ] || [ "$a" = recover ] || { outcome skip "$a"; return; }
  [ "$(status_of attempt)" = ok ] || { outcome skip attempt_not_ok; return; }
  [ -n "$s" ] || { outcome infra_error no_sha; return; }
  renew_loop
  fence
  if [ "$a" = deploy ]; then
    PV="$(current_sha)"; PH="$(state_get prevhash)"; [ -n "$PV" ] && PH="$(hash_of "$PV")"
    if [ "$(status_of copy)" != ok ]; then outcome skip copy_not_ok; kill "$RENEW_PID" 2>/dev/null; return; fi
    case "$(read_word /stageout/result)" in
      pass) ;;
      conf) state_put failed_check nginx_config "$s" "$PV" "$PH" 0; outcome failed_check nginx_config; kill "$RENEW_PID" 2>/dev/null; return ;;
      timeout) state_put failed_timeout stage_timeout "$s" "$PV" "$PH" 0; outcome failed_timeout stage; kill "$RENEW_PID" 2>/dev/null; return ;;
      *) state_put failed_smoke stage_smoke "$s" "$PV" "$PH" 0; outcome failed_smoke stage; kill "$RENEW_PID" 2>/dev/null; return ;;
    esac
  fi
  if [ "$(serving_mode)" != release-volume ]; then # before cutover: publish only
    [ "$a" = deploy ] || { outcome skip not_cut_over; kill "$RENEW_PID" 2>/dev/null; return; }
    point_to "$s"; state_put published not_cut_over "$s" none none 0; outcome published not_cut_over
    kill "$RENEW_PID" 2>/dev/null; return
  fi
  if [ "$a" = deploy ]; then
    state_put switching switching "$s" "$PV" "$PH" 0
    point_to "$s"
    if go_live_check "$s"; then state_put ok live "$s" "$PV" "$PH" 0; outcome ok live
    else rollback "$s" live_smoke; fi
  else # recover, from the recorded state
    st="$(state_get state)"; PV="$(state_get previous)"; PH="$(state_get prevhash)"
    [ "$PV" = none ] && PV=""
    case "$st" in
      staging) state_put infra_error interrupted_staging "$s" "$PV" "$PH" 1; outcome infra_error interrupted_staging ;;
      switching) if [ "$(current_sha)" != "$s" ]; then state_put infra_error interrupted_switch "$s" "$PV" "$PH" 1; outcome infra_error interrupted_switch
                 elif go_live_check "$s"; then state_put ok live_recovered "$s" "$PV" "$PH" 0; outcome ok live_recovered
                 else rollback "$s" live_smoke; fi ;;
      restarting) if [ "$(current_sha)" = "$s" ] && go_live_check "$s"; then state_put ok live_recovered "$s" "$PV" "$PH" 0; outcome ok live_recovered
                  else rollback "$s" live_smoke; fi ;;
      rolling_back) rollback "$s" live_smoke ;;
      *) outcome skip "nothing_to_recover" ;;
    esac
  fi
  kill "$RENEW_PID" 2>/dev/null
  # keep the last 10 releases, current and previous
  cur="$(current_sha)"; prv="$(state_get previous)"
  ls -1t "$SITE/releases" 2>/dev/null | grep "$HEX40" | tail -n +11 | while read -r r; do
    [ "$r" = "$cur" ] || [ "$r" = "$prv" ] || rm -rf "${SITE:?}/releases/$r"; done
  rm -rf "$SITE"/releases/.tmp-* 2>/dev/null || true
}

step_report() { # token, Slack webhook; sets the Job's exit code
  final=skip; reason=nothing_to_do
  # Only the switch step's ok/published makes a run "ok". A step that failed
  # sets the result; skips and intermediate oks (lock taken, fetched) do not.
  for st in lock fetch attempt copy switch; do
    [ -f "$TRUSTED/status/$st" ] || continue
    o="$(cut -d' ' -f1 "$TRUSTED/status/$st")"; r="$(cut -d' ' -f2 "$TRUSTED/status/$st")"
    case "$st:$o" in
      *:skip|lock:ok|fetch:ok|attempt:ok|copy:ok) ;;
      switch:ok|switch:published) final="$o"; reason="$r" ;;
      *) final="$o"; reason="$r" ;;
    esac
  done
  echo "$final" | grep -q '^[a-z_]\{1,24\}$' || final=invalid
  echo "$reason" | grep -q '^[a-z0-9_]\{1,40\}$' || reason=invalid
  s="$(sha)"; s="${s:-none}"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  data="{\"heartbeat\":\"$ts\",\"deployer\":\"$(deployer_version | cut -c1-12)\""
  [ "$final" != skip ] && data="$data,\"state\":\"$final\",\"reason\":\"$reason\",\"commit\":\"$s\",\"time\":\"$ts\""
  kubectl -n "$NS" patch configmap site-deploy-state --type merge -p "{\"data\":$data}}" >/dev/null || log "heartbeat write failed"
  case "$final" in
    ok|skip|published) ;;
    *) if [ -s /slack/webhook ]; then
         curl -sS --max-time 10 -X POST -H 'Content-Type: application/json' \
           --data "{\"text\":\"reliora.ai deploy: $final ($reason), commit ${s%"${s#???????}"}. See configmap reliora-website/site-deploy-state.\"}" \
           "$(head -c 300 /slack/webhook)" >/dev/null || log "slack post failed"
       fi ;;
  esac
  lease_mine && kubectl -n "$NS" patch lease site-deployer --type merge -p '{"spec":{"holderIdentity":""}}' >/dev/null 2>&1
  log "final: $final $reason"
  case "$final" in ok|skip|published) exit 0 ;; *) exit 1 ;; esac
}

case "$STEP" in
  lock) step_lock ;; fetch) step_fetch ;; attempt) step_attempt ;; check) step_check ;;
  copy) step_copy ;; stage) step_stage ;; switch) step_switch ;; report) step_report ;;
  *) echo "unknown step $STEP" >&2; exit 2 ;;
esac
exit 0
