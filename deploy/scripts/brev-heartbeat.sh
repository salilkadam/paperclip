#!/usr/bin/env bash
# brev-heartbeat.sh — keep a Brev CLI session alive so instances (e.g. the
# Crusoe base node `paperclip-linux`) can be reached on demand.
#
# Why this exists (verified 2026-10-17, brev-cli v0.6.335):
#   - The CLI stores a 15-minute NVIDIA JWT access token and an opaque refresh
#     token in ~/.brev/credentials.json. Any authenticated command refreshes
#     the access token on demand. The refresh token does NOT rotate.
#   - The refresh token's lifetime is undocumented. An idle session from
#     2026-10-15 had expired by 2026-10-17, so regular use is needed.
#   - `ssh <instance>` mints a ~5-minute SSH certificate per connection
#     (`brev mint-cert`, via ~/.brev/ssh_config), which needs valid auth.
#
# Each cycle:
#   1. `brev ls --json` with stdin closed. This uses and renews the session,
#      and it can never block on the interactive "log in?" prompt.
#   2. Every BREV_HEARTBEAT_REFRESH_EVERY cycles, `brev refresh` updates the
#      SSH config, because ports change when instances restart.
#   3. An SSH probe (`ssh <target> true`) to each target proves on-demand access.
#   4. Writes status.json and log lines, and alerts only on state changes.
#
# It never starts or stops instances unless BREV_HEARTBEAT_ENSURE_RUNNING=1.
# Instances bill while running.
#
# A Brev API key (`brev login --api-key bak-...`, or the BREV_API_KEY env var)
# would avoid session expiry entirely. When one is configured, this script
# still provides the SSH probe and the alerting.
#
# Usage:
#   brev-heartbeat.sh once           run one cycle in the foreground
#   brev-heartbeat.sh run            foreground loop (for containers/CronJob-less hosts)
#   brev-heartbeat.sh start          start the background loop (single instance)
#   brev-heartbeat.sh ensure         start it only if it is not running (quiet; for shell hooks)
#   brev-heartbeat.sh stop           stop the background loop
#   brev-heartbeat.sh status         print status.json and whether the loop is running
#   brev-heartbeat.sh install-hook   add an `ensure` line to ~/.bashrc (idempotent)
#   brev-heartbeat.sh uninstall-hook remove that line
#
# Environment:
#   BREV_BIN                       brev binary (default: `command -v brev`)
#   BREV_HEARTBEAT_INTERVAL        seconds between cycles (default 600; keep under 900)
#   BREV_HEARTBEAT_TARGETS         space-separated instance names to SSH-probe
#                                  (default "paperclip-linux"; empty disables probing)
#   BREV_HEARTBEAT_REFRESH_EVERY   run `brev refresh` every N cycles (default 6)
#   BREV_HEARTBEAT_ENSURE_RUNNING  1 = `brev start` targets found STOPPED (default 0)
#   BREV_HEARTBEAT_SLACK_WEBHOOK   optional Slack incoming-webhook URL for alerts
#   BREV_HEARTBEAT_DIR             state dir (default ~/.brev/heartbeat)
set -uo pipefail

BREV_BIN="${BREV_BIN:-$(command -v brev || true)}"
INTERVAL="${BREV_HEARTBEAT_INTERVAL:-600}"
TARGETS="${BREV_HEARTBEAT_TARGETS-paperclip-linux}"
REFRESH_EVERY="${BREV_HEARTBEAT_REFRESH_EVERY:-6}"
ENSURE_RUNNING="${BREV_HEARTBEAT_ENSURE_RUNNING:-0}"
SLACK_WEBHOOK="${BREV_HEARTBEAT_SLACK_WEBHOOK:-}"
STATE_DIR="${BREV_HEARTBEAT_DIR:-$HOME/.brev/heartbeat}"

LOG_FILE="$STATE_DIR/heartbeat.log"
STATUS_FILE="$STATE_DIR/status.json"
LAST_STATE_FILE="$STATE_DIR/last_state"
PID_FILE="$STATE_DIR/heartbeat.pid"
LOCK_FILE="$STATE_DIR/heartbeat.lock"
CYCLE_FILE="$STATE_DIR/cycle"
LOG_MAX_BYTES=1048576
HOOK_BEGIN="# >>> brev-heartbeat >>>"
HOOK_END="# <<< brev-heartbeat <<<"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log() {
  if [ -f "$LOG_FILE" ] && [ "$(wc -c <"$LOG_FILE")" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
  fi
  printf '%s %s\n' "$(ts)" "$*" >>"$LOG_FILE"
}

# Minutes until the saved access token expires, read from the JWT `exp` claim.
# Prints nothing if it cannot be determined. Never prints token material.
access_token_minutes_left() {
  command -v python3 >/dev/null 2>&1 || return 0
  python3 - "$HOME/.brev/credentials.json" <<'PY' 2>/dev/null || true
import base64, json, sys, time
try:
    tok = json.load(open(sys.argv[1])).get("access_token", "")
    part = tok.split(".")[1]
    part += "=" * (-len(part) % 4)
    exp = json.loads(base64.urlsafe_b64decode(part)).get("exp")
    if exp:
        print(round((exp - time.time()) / 60, 1))
except Exception:
    pass
PY
}

alert() {
  local message="$1"
  log "ALERT $message"
  if [ -n "$SLACK_WEBHOOK" ] && command -v curl >/dev/null 2>&1; then
    local payload
    payload="$(jq -n --arg text "[brev-heartbeat $(hostname)] $message" '{text: $text}')"
    curl -fsS -m 10 -H 'Content-Type: application/json' -d "$payload" "$SLACK_WEBHOOK" >/dev/null 2>&1 \
      || log "WARN slack alert delivery failed"
  fi
}

next_cycle() {
  local n=0
  [ -f "$CYCLE_FILE" ] && n="$(cat "$CYCLE_FILE" 2>/dev/null || echo 0)"
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  n=$((n + 1))
  echo "$n" >"$CYCLE_FILE"
  echo "$n"
}

run_once() {
  if [ -z "$BREV_BIN" ] || [ ! -x "$BREV_BIN" ]; then
    log "ERROR brev binary not found (set BREV_BIN)"
    write_status "error" "brev_binary_missing" "[]" ""
    transition "error:brev_binary_missing" "brev CLI binary not found on this host."
    return 1
  fi

  local cycle ls_json ls_rc
  cycle="$(next_cycle)"

  # 1. Auth: stdin closed, so an expired session fails fast instead of prompting.
  ls_json="$(timeout 90 "$BREV_BIN" ls --json --no-check-latest </dev/null 2>/dev/null)"
  ls_rc=$?
  if [ "$ls_rc" -ne 0 ] || ! printf '%s' "$ls_json" | jq -e '.workspaces' >/dev/null 2>&1; then
    log "FAIL auth: brev ls exit=$ls_rc (session expired or Brev API unreachable)"
    write_status "auth_failed" "brev_ls_failed" "[]" "$(access_token_minutes_left)"
    transition "auth_failed" "Brev session is not usable (brev ls exit=$ls_rc). Re-login: brev login --skip-browser --email <you> (or configure a Brev API key)."
    return 1
  fi

  # 2. Periodic SSH-config refresh.
  if [ "$REFRESH_EVERY" -gt 0 ] && [ $((cycle % REFRESH_EVERY)) -eq 1 ]; then
    if timeout 120 "$BREV_BIN" refresh --no-check-latest </dev/null >/dev/null 2>&1; then
      log "ok   brev refresh (ssh config)"
    else
      log "WARN brev refresh failed"
    fi
  fi

  # 3. Per-target status and SSH probe.
  local results="[]" overall="ok" failures=""
  local target status probe
  for target in $TARGETS; do
    status="$(printf '%s' "$ls_json" | jq -r --arg n "$target" '.workspaces[] | select(.name == $n) | .status' | head -n1)"
    [ -z "$status" ] && status="NOT_FOUND"

    if [ "$status" = "STOPPED" ] && [ "$ENSURE_RUNNING" = "1" ]; then
      log "info $target is STOPPED; starting (BREV_HEARTBEAT_ENSURE_RUNNING=1)"
      timeout 900 "$BREV_BIN" start "$target" --no-check-latest </dev/null >/dev/null 2>&1 \
        || log "WARN brev start $target failed"
    fi

    probe="skipped"
    if [ "$status" = "RUNNING" ]; then
      if timeout 90 ssh -o BatchMode=yes -o ConnectTimeout=30 -o ControlMaster=no \
          -o ControlPath=none -o LogLevel=ERROR "$target" true </dev/null >/dev/null 2>&1; then
        probe="ok"
      else
        probe="failed"
      fi
    fi

    if [ "$status" != "RUNNING" ] || [ "$probe" != "ok" ]; then
      overall="degraded"
      failures="$failures $target(status=$status,ssh=$probe)"
    fi
    results="$(printf '%s' "$results" | jq --arg n "$target" --arg s "$status" --arg p "$probe" \
      '. + [{name: $n, status: $s, ssh: $p}]')"
    log "$([ "$probe" = ok ] && echo 'ok  ' || echo 'WARN') $target status=$status ssh=$probe"
  done

  local minutes
  minutes="$(access_token_minutes_left)"
  write_status "$overall" "" "$results" "$minutes"
  log "ok   auth (access token ${minutes:-?} min left, cycle $cycle)"

  if [ "$overall" = "ok" ]; then
    transition "ok" "Brev session healthy; targets reachable:${TARGETS:+ $TARGETS}."
  else
    transition "degraded" "Brev session OK but targets not reachable:$failures"
  fi
  return 0
}

write_status() {
  local state="$1" reason="$2" targets="$3" minutes="$4"
  jq -n --arg checked_at "$(ts)" --arg state "$state" --arg reason "$reason" \
    --argjson targets "$targets" --arg minutes "$minutes" --arg host "$(hostname)" \
    '{checked_at: $checked_at, host: $host, state: $state,
      reason: (if $reason == "" then null else $reason end),
      access_token_minutes_left: ($minutes | tonumber? // null), targets: $targets}' \
    >"$STATUS_FILE.tmp" 2>/dev/null && mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

# Alert only when the state changes (healthy <-> failing), not every cycle.
transition() {
  local state="$1" message="$2" previous=""
  [ -f "$LAST_STATE_FILE" ] && previous="$(cat "$LAST_STATE_FILE")"
  if [ "$state" != "$previous" ]; then
    echo "$state" >"$LAST_STATE_FILE"
    if [ -n "$previous" ] || [ "$state" != "ok" ]; then
      alert "state ${previous:-none} -> $state: $message"
    fi
  fi
}

loop() {
  log "start loop pid=$$ interval=${INTERVAL}s targets='${TARGETS}'"
  trap 'log "stop loop pid=$$"; rm -f "$PID_FILE"; exit 0' INT TERM
  while :; do
    run_once || true
    sleep "$INTERVAL" &
    wait $!
  done
}

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start_background() {
  if is_running; then
    [ "${1:-}" = "quiet" ] || echo "brev-heartbeat already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  # flock makes concurrent `ensure` calls from several shells start one loop.
  (
    flock -n 9 || exit 0
    is_running && exit 0
    nohup setsid "$SCRIPT_PATH" run </dev/null >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  ) 9>"$LOCK_FILE"
  [ "${1:-}" = "quiet" ] || { sleep 1; is_running && echo "brev-heartbeat started (pid $(cat "$PID_FILE"))" || echo "brev-heartbeat failed to start; see $LOG_FILE"; }
}

stop_background() {
  if is_running; then
    kill "$(cat "$PID_FILE")" 2>/dev/null
    rm -f "$PID_FILE"
    echo "brev-heartbeat stopped"
  else
    rm -f "$PID_FILE"
    echo "brev-heartbeat not running"
  fi
}

install_hook() {
  local rc="$HOME/.bashrc"
  if grep -qF "$HOOK_BEGIN" "$rc" 2>/dev/null; then
    echo "hook already present in $rc"
    return 0
  fi
  {
    echo ""
    echo "$HOOK_BEGIN"
    echo "[ -x \"$SCRIPT_PATH\" ] && \"$SCRIPT_PATH\" ensure >/dev/null 2>&1"
    echo "$HOOK_END"
  } >>"$rc"
  echo "hook added to $rc"
}

uninstall_hook() {
  local rc="$HOME/.bashrc"
  if grep -qF "$HOOK_BEGIN" "$rc" 2>/dev/null; then
    sed -i "/$(printf '%s' "$HOOK_BEGIN" | sed 's/[]\/$*.^[]/\\&/g')/,/$(printf '%s' "$HOOK_END" | sed 's/[]\/$*.^[]/\\&/g')/d" "$rc"
    echo "hook removed from $rc"
  else
    echo "no hook in $rc"
  fi
}

case "${1:-}" in
  once) run_once; rc=$?; cat "$STATUS_FILE" 2>/dev/null; exit "$rc" ;;
  run) echo $$ >"$PID_FILE"; loop ;;
  start) start_background ;;
  ensure) start_background quiet ;;
  stop) stop_background ;;
  status)
    if is_running; then echo "loop: running (pid $(cat "$PID_FILE"))"; else echo "loop: not running"; fi
    cat "$STATUS_FILE" 2>/dev/null || echo "no status yet"
    ;;
  install-hook) install_hook ;;
  uninstall-hook) uninstall_hook ;;
  *)
    sed -n '2,46p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
