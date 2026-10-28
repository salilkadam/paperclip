#!/usr/bin/env bash
# setup-cmo-blog-amplifier.sh — give the C-levels team authority and set up the
# CMO organisation's daily blog -> LinkedIn routine, idempotently, in every
# company listed in SITES below.
#
# Per company it:
#   1. turns on team authority (agents:configure scoped to the agent's own
#      reporting subtree) for the CMO, COO and CLO: PUT /agents/:id/team-authority.
#      Agents that already hold a company-wide grant (CEO, CIO) are not touched;
#   2. ensures a "Marketing" project led by the CMO;
#   2a. adds the routine's skills to the marketer (mode "add", never replace);
#   3. ensures the routine "Daily blog -> LinkedIn" assigned to the CMO's
#      marketing report (exactly one direct report of the CMO, or it stops),
#      with the inputs the blog-linkedin-amplifier skill needs in its
#      description, concurrency skip_if_active and catch-up skip_missed;
#   4. ensures one schedule trigger (daily 08:00 America/Los_Angeles);
#   5. reads everything back and fails if any value differs.
#
# Nothing here publishes. Every go-live the routine requests is a board
# approval card (Ghost + TryPost ask-first policies).
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key of an instance admin (`paperclipai token board create --name cmo-amp
# --ttl-days 1`). The key never appears on a command line.
# Board Slack channel per company is the 5th SITES field; the CMO's Slack bot
# (cmo-<site>) posts there. Override with BOARD_SLACK_CHANNEL_<SITE>.
#
# Usage: deploy/scripts/setup-cmo-blog-amplifier.sh [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
PERSONAL_PROFILE="${PERSONAL_LINKEDIN_PROFILE:-Salil Kadam}"
ROUTINE_TITLE="Daily blog -> LinkedIn"
CRON="0 8 * * *"; TZ_NAME="America/Los_Angeles"
# site|company name|PUBLIC blog base URL|LinkedIn page display name|board Slack channel|daily routine on/off
# The public base URL is the company website's blog (the site renders published
# Ghost posts at <base>/<slug>), never the Ghost host blog-*.baisoln.com, which
# is intranet-only. Empty = no public blog yet: the routine stops before drafting.
# "off": the company runs a different calendar (Reliora: setup-reliora-content-calendar.sh),
# so this script keeps its "Daily blog -> LinkedIn" routine PAUSED instead of re-activating it.
SITES=(
  "bionic|Bionic AI Solutions||Bionic AI Solutions|#bionic-board|on"
  "reliora|Reliora Inc|https://reliora.ai/blog|Reliora Inc|#reliora-board|off"
)
C_LEVEL_NAMES=(CMO COO CLO)
MARKETER_SKILLS=(paperclipai/paperclip/blog-linkedin-amplifier paperclipai/paperclip/trypost)
DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[cmo-blog-amplifier] $*" >&2; }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"

# api METHOD PATH [json-file] -> body on stdout; non-2xx is fatal with the body.
api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-cmo-blog-amplifier/1' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}
# write: run a mutating call unless --dry-run.
write() { if (( DRY )); then log "  DRY-RUN would $1 $2"; echo '{}'; else api "$@"; fi; }

companies="$(api GET /companies)"

for entry in "${SITES[@]}"; do
  IFS='|' read -r site cname blog_url page board_chan daily <<<"$entry"
  rstatus=active; [[ "$daily" == off ]] && rstatus=paused
  log "== $cname ($site)"
  cid="$(jq -r --arg n "$cname" '[.[] | select(.name == $n and .status == "active")] | if length == 1 then .[0].id else "" end' <<<"$companies")"
  [[ -n "$cid" ]] || die "expected exactly one active company named '$cname'"
  agents="$(api GET "/companies/$cid/agents")"

  # 1. team authority for the C-levels
  for name in "${C_LEVEL_NAMES[@]}"; do
    aid="$(jq -r --arg n "$name" '[.[] | select(.name == $n and .status != "terminated")] | if length == 1 then .[0].id else "" end' <<<"$agents")"
    [[ -n "$aid" ]] || { log "  $name: not present, skipped"; continue; }
    jq -n '{enabled: true}' > "$WORK/ta.json"
    res="$(write PUT "/agents/$aid/team-authority" "$WORK/ta.json")"
    log "  $name team authority: $(jq -c '{enabled, changed}' <<<"$res")"
  done

  cmo="$(jq -r '[.[] | select(.name == "CMO" and .status != "terminated")] | if length == 1 then .[0].id else "" end' <<<"$agents")"
  [[ -n "$cmo" ]] || die "$cname: expected exactly one CMO"
  marketer="$(jq -r --arg c "$cmo" '[.[] | select(.reportsTo == $c and .status != "terminated")] | if length == 1 then .[0].id else "" end' <<<"$agents")"
  [[ -n "$marketer" ]] || die "$cname: expected exactly one direct report of the CMO (the marketer)"
  log "  marketer: $(jq -r --arg m "$marketer" '.[] | select(.id == $m) | .name' <<<"$agents")"

  # 2a. the marketer needs the routine's skills; mode "add" keeps every other
  #     assigned skill (other setups manage those).
  jq -n --argjson k "$(printf '%s\n' "${MARKETER_SKILLS[@]}" | jq -R . | jq -s .)" '{mode: "add", desiredSkills: $k}' > "$WORK/s.json"
  skills="$(write POST "/agents/$marketer/skills/sync" "$WORK/s.json")"
  if (( ! DRY )); then
    for k in "${MARKETER_SKILLS[@]}"; do
      jq -e --arg k "$k" '[.entries[]? | select(.key == $k and .desired)] | length == 1' <<<"$skills" >/dev/null \
        || die "$cname: marketer skill $k is not desired after sync"
    done
    log "  marketer skills: ${MARKETER_SKILLS[*]} desired"
  fi

  # 2. Marketing project
  projects="$(api GET "/companies/$cid/projects")"
  pid="$(jq -r '(if type == "object" then .projects else . end) | [.[] | select(.name == "Marketing" and (.archivedAt == null))] | .[0].id // ""' <<<"$projects")"
  if [[ -z "$pid" ]]; then
    jq -n --arg lead "$cmo" '{name: "Marketing", status: "in_progress", leadAgentId: $lead,
      description: "Content, blog and social publishing run by the CMO organisation."}' > "$WORK/p.json"
    pid="$(write POST "/companies/$cid/projects" "$WORK/p.json" | jq -r '.id // "DRY-RUN"')"
    log "  project Marketing: created $pid"
  else
    log "  project Marketing: ok $pid"
  fi

  # 3. routine
  chan_var="BOARD_SLACK_CHANNEL_${site^^}"; chan="${!chan_var:-$board_chan}"
  desc="$(cat <<EOF
Use the **blog-linkedin-amplifier** skill. Inputs:

- Ghost tenant_id: \`$site\`
$(if [[ -n "$blog_url" ]]; then cat <<URL
- Public blog base URL: $blog_url. Link posts ONLY to \`$blog_url/<slug>\`. Never link the Ghost host
  (\`blog-$site.baisoln.com\`) or a draft preview URL: those are intranet-only and do not open for readers.
  After the blog is published, open \`$blog_url/<slug>\` and confirm the page title is the post title
  before closing the run; if it is not, pull both LinkedIn posts back to draft and say so.
URL
else cat <<NOURL
- Public blog base URL: **none yet**. The company website does not show blog posts publicly yet.
  Do not draft or schedule LinkedIn posts: comment "No public blog URL yet", mark the run done, and end.
NOURL
fi)
- Ledger tag: exactly \`#linkedin\` WITH the leading \`#\` (internal, Ghost slug hash-linkedin). Never send
  \`linkedin\` without the \`#\`: it becomes a public tag shown on the company website.
- Company LinkedIn page: **$page**
- Personal LinkedIn profile for the repost: **$PERSONAL_PROFILE** (the only personal profile you may post to)
- Board Slack channel: \`$chan\`. Send the board note by following the company's **board-approval-notify** skill, written by the **board-plain-language** skill. If that skill is not available to you, post with your Slack tools, or create the "Slack board note" subtask for your manager (the CMO), whose bot (cmo-$site) posts it.

Pick one new draft blog, publish it, and schedule its company and personal LinkedIn
posts. All of this goes through ONE board decision (Approve all on this task).
Never repeat a blog.
EOF
)"
  routines="$(api GET "/companies/$cid/routines")"
  rid="$(jq -r --arg t "$ROUTINE_TITLE" '[.[] | select(.title == $t and .status != "archived")] | .[0].id // ""' <<<"$routines")"
  jq -n --arg t "$ROUTINE_TITLE" --arg d "$desc" --arg a "$marketer" --arg p "$pid" --arg s "$rstatus" '{title: $t, description: $d,
    assigneeAgentId: $a, projectId: $p, priority: "medium", status: $s,
    concurrencyPolicy: "skip_if_active", catchUpPolicy: "skip_missed"}' > "$WORK/r.json"
  if [[ -z "$rid" ]]; then
    rid="$(write POST "/companies/$cid/routines" "$WORK/r.json" | jq -r '.id // "DRY-RUN"')"
    log "  routine: created $rid"
  else
    write PATCH "/routines/$rid" "$WORK/r.json" >/dev/null
    log "  routine: updated $rid"
  fi

  # 4. schedule trigger
  if [[ "$rid" != DRY-RUN ]]; then
    detail="$(api GET "/routines/$rid")"
    if jq -e --arg c "$CRON" --arg z "$TZ_NAME" '[.triggers[]? | select(.kind == "schedule" and .cronExpression == $c and .timezone == $z)] | length == 1' <<<"$detail" >/dev/null; then
      log "  trigger: ok"
    else
      jq -n --arg c "$CRON" --arg z "$TZ_NAME" '{kind: "schedule", label: "daily 08:00 PT", cronExpression: $c, timezone: $z, enabled: true}' > "$WORK/t.json"
      write POST "/routines/$rid/triggers" "$WORK/t.json" >/dev/null
      log "  trigger: created"
    fi

    # 5. read back and compare
    if (( ! DRY )); then
      detail="$(api GET "/routines/$rid")"
      jq -e --arg a "$marketer" --arg p "$pid" --arg c "$CRON" --arg z "$TZ_NAME" --arg s "$rstatus" '
        .assigneeAgentId == $a and .projectId == $p and .status == $s
        and .concurrencyPolicy == "skip_if_active"
        and ([.triggers[] | select(.kind == "schedule" and .enabled and .cronExpression == $c and .timezone == $z)] | length == 1)' \
        <<<"$detail" >/dev/null || die "$cname: routine read-back does not match: $(jq -c '{assigneeAgentId, projectId, status, concurrencyPolicy, triggers: [.triggers[] | {kind, enabled, cronExpression, timezone, nextRunAt}]}' <<<"$detail")"
      log "  verified ($rstatus); next run $(jq -r '[.triggers[] | select(.kind == "schedule")][0].nextRunAt' <<<"$detail")"
    fi
  fi
done
log "done"
