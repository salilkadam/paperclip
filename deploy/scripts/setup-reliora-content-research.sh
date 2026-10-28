#!/usr/bin/env bash
# Reliora content research: three routines for the Content Marketer (the CMO's
# direct report) that feed the content calendar with blogs about problems
# people are posting this week.
#
#   1. "Reliora product research" — Mondays 05:00 PT. Reads the product's
#      repositories through the GitHub connection and keeps the capability notes
#      in the marketer's memory ($AGENT_HOME/life/resources/srenix/). Skill:
#      product-capability-notes.
#   2. "Reliora community scan" — daily 06:00 PT, an hour before the calendar.
#      Searches Reddit and Stack Exchange through the Composio connection and
#      Hacker News through its public API, matches the problems against the notes, and writes at most one
#      Ghost draft. Skill: community-pain-blog. The draft's "post created"
#      webhook wakes "Reliora content calendar" (setup-reliora-content-calendar.sh),
#      which formats, schedules and asks the board. Creating a post that is not a
#      draft is ask-first at the gateway (setup-ghost-governance.sh).
#
# It also:
#   - checks that the company's "GitHub" and "Composio" connections are active;
#   - blocks every GitHub tool of risk write/destructive for the marketer (a
#     company policy scoped to the marketer and that connection), then proves
#     it: a write test call must be refused, a read allowed;
#   - "Reliora source back-post" — daily 09:30 PT: drafts one community reply a
#     person posts (skill source-back-post); posting is blocked at the gateway
#     (setup-composio-governance.sh). Private agent copies of community-pain-blog
#     and source-back-post are unselected;
#   - adds the routines' skills to the marketer (mode "add") and checks they
#     resolved;
#   - creates the seed task "Srenix capability notes: seed" (unassigned, done)
#     holding the first notes as documents `summary` and `items`, when SEED_DIR
#     is given and the task does not exist yet;
#   - reads everything back and fails if any value differs.
#
# The repositories to research are read from REPOS_FILE (default
# ~/.reliora-research-repos), NOT from this public repo: one per line,
# "<owner>/<repo> <source-available|proprietary>". Names of proprietary
# repositories therefore never appear in git.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key (`paperclipai token board create --ttl-days 1`). Never on a command line.
# Optional: REPOS_FILE; SEED_DIR — a directory with summary.md and items.yaml.
#
# Usage: deploy/scripts/setup-reliora-content-research.sh [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
COMPANY="Reliora Inc"
TZ_NAME="America/Los_Angeles"
RES_TITLE="Reliora product research"
RES_CRON="0 5 * * 1"
SCAN_TITLE="Reliora community scan"
SCAN_CRON="0 6 * * *"
SEED_TITLE="Srenix capability notes: seed"
GITHUB_CONN="GitHub"
COMPOSIO_CONN="Composio"
GH_BLOCK_POLICY="org-instructions: content marketer reads GitHub only"
REPOS_FILE="${REPOS_FILE:-$HOME/.reliora-research-repos}"
SEED_DIR="${SEED_DIR:-}"
BACK_TITLE="Reliora source back-post"
BACK_CRON="30 9 * * *"
MARKETER_SKILLS=(paperclipai/paperclip/product-capability-notes paperclipai/paperclip/community-pain-blog paperclipai/paperclip/blog-visuals paperclipai/paperclip/source-back-post paperclipai/paperclip/para-memory-files)
# private company copies the agent made on 28 Oct; the bundled skills above replace them
RETIRED_SKILLS=(community-pain-blog source-back-post)
DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[reliora-research] $*" >&2; }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"
[[ -r "$REPOS_FILE" ]] || die "REPOS_FILE ($REPOS_FILE) must list the repositories, one '<owner>/<repo> <source-available|proprietary>' per line"
if [[ -n "$SEED_DIR" ]]; then
  [[ -r "$SEED_DIR/summary.md" && -r "$SEED_DIR/items.yaml" ]] || die "SEED_DIR must contain summary.md and items.yaml"
fi

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"

api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-reliora-research/1' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}
write() { if (( DRY )); then log "  DRY-RUN would $1 $2"; echo '{}'; else api "$@"; fi; }

# the repository list, from the private file
repo_lines=""
while read -r repo kind _; do
  [[ -z "$repo" || "$repo" == \#* ]] && continue
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "$REPOS_FILE: '$repo' is not <owner>/<repo>"
  case "$kind" in
    source-available) repo_lines+="  - \`$repo\` — **source-available**: its facts may be public."$'\n' ;;
    proprietary) repo_lines+="  - \`$repo\` — **proprietary**: everything from it is \`internal\`, never blog material."$'\n' ;;
    *) die "$REPOS_FILE: '$repo' needs 'source-available' or 'proprietary', got '$kind'" ;;
  esac
done < "$REPOS_FILE"
[[ -n "$repo_lines" ]] || die "$REPOS_FILE lists no repositories"

RES_DESC="Weekly product research for reliora.ai's content. Use the **product-capability-notes** skill.

- Product: \`srenix\`. Notes folder: \`\$AGENT_HOME/life/resources/srenix/\` (\`summary.md\`, \`items.yaml\`).
- Repositories (GitHub connection, read tools only; write tools are blocked for you):
${repo_lines}- First run only: if the notes folder is empty, copy the documents \`summary\` and \`items\` of the task titled
  \"$SEED_TITLE\" into the folder as \`summary.md\` and \`items.yaml\`, then read what changed since the commits
  its first lines record.

Finish with a short comment in plain words: what changed in Srenix this week, and the commits you read. Mark the task done."

read -r -d '' SCAN_DESC <<'EOF' || true
Daily community scan for reliora.ai. Use the **community-pain-blog** skill. Times are America/Los_Angeles.

- Ghost tenant `reliora`; public blog https://reliora.ai/blog/ . Style reference posts (`gh_get_post` by slug):
  `expiring-certificates-outage` and `crashloopbackoff-six-causes`.
- Product notes: `$AGENT_HOME/life/resources/srenix/` (kept by "Reliora product research"). Topic ledger:
  `$AGENT_HOME/life/resources/blog-topics/ledger.md`.
- Sources: through the Composio connection, Reddit `kubernetes`, `sre`, `devops` and Stack Exchange
  `serverfault`, `stackoverflow` and `devops` (tag `kubernetes`); Hacker News queries `kubernetes`, `outage`,
  `postmortem`, `postgres`, `on-call` through its public Algolia API from your own runtime.
- Queue limit: 6 (see the skill for what counts). At or above it, bank the topic instead of drafting.

At most one new **draft** (`status: "draft"`, sent explicitly). Never publish or schedule: the "Reliora content
calendar" routine does that with the board's approval when Ghost reports the draft. Finish with the shortlist
and the draft's title (or why none), in plain words, and mark the task done.
EOF

read -r -d '' BACK_DESC <<'DESC' || true
Daily source back-post for reliora.ai. Use the **source-back-post** skill. Times are America/Los_Angeles.

- Ghost tenant `reliora`; public blog https://reliora.ai/blog/ . Ledger and reply log in
  `$AGENT_HOME/life/resources/blog-topics/` (`ledger.md`, `replies.md`). If they are missing there, copy them
  once from `/paperclip/instances/default/skills/62d63984-df6c-49be-981c-1273f68a451c/community-pain-blog/blog-topics/`.
- Owner's decisions (2026-10-28): every community reply is **posted by a person**; you only draft it. Threads:
  the blog's own source, and recent threads a live blog genuinely answers (relevance gate). Limits: 1 reply per
  thread, 1 per subreddit/site per 7 days, 2 per blog. The first two replies go to the CMO before the board.
- You cannot post to Reddit, Hacker News or Stack Exchange: the gateway blocks it. Never ask for that access.

At most one reply per run. Finish with the thread, the ready-to-post reply (or why nothing passed), in plain
words, and set the task `in_review` when a reply waits for a person, otherwise `done`.
DESC

companies="$(api GET /companies)"
cid="$(jq -r --arg n "$COMPANY" '[.[] | select(.name == $n and .status == "active")] | if length == 1 then .[0].id else "" end' <<<"$companies")"
[[ -n "$cid" ]] || die "expected exactly one active company named '$COMPANY'"
agents="$(api GET "/companies/$cid/agents")"
cmo="$(jq -r '[.[] | select(.name == "CMO" and .status != "terminated")] | if length == 1 then .[0].id else "" end' <<<"$agents")"
[[ -n "$cmo" ]] || die "expected exactly one CMO"
marketer="$(jq -r --arg c "$cmo" '[.[] | select(.reportsTo == $c and .status != "terminated")] | if length == 1 then .[0].id else "" end' <<<"$agents")"
[[ -n "$marketer" ]] || die "expected exactly one direct report of the CMO (the marketer)"
projects="$(api GET "/companies/$cid/projects")"
pid="$(jq -r '(if type == "object" then .projects else . end) | [.[] | select(.name == "Marketing" and (.archivedAt == null))] | .[0].id // ""' <<<"$projects")"
[[ -n "$pid" ]] || die "no Marketing project (run setup-cmo-blog-amplifier.sh first)"
log "== $COMPANY: marketer $(jq -r --arg m "$marketer" '.[] | select(.id == $m) | .name' <<<"$agents"), project $pid"

# the connections the routines depend on
conns="$(api GET "/companies/$cid/tools/connections" | jq '(.connections // .)')"
conn_id() { jq -r --arg n "$1" '[.[] | select(.name == $n and .status == "active")] | if length == 1 then .[0].id else "" end' <<<"$conns"; }
gh_conn="$(conn_id "$GITHUB_CONN")"; [[ -n "$gh_conn" ]] || die "expected exactly one active '$GITHUB_CONN' connection"
cp_conn="$(conn_id "$COMPOSIO_CONN")"; [[ -n "$cp_conn" ]] || die "expected exactly one active '$COMPOSIO_CONN' connection"
log "  connections: $GITHUB_CONN $gh_conn, $COMPOSIO_CONN $cp_conn (active)"

# GitHub: the marketer reads only
want="$(jq -n --arg conn "$gh_conn" --arg a "$marketer" --arg n "$GH_BLOCK_POLICY" '
  { name: $n, description: "The content marketer researches product repositories; it never writes to them.",
    policyType: "block", priority: 40, enabled: true,
    selectors: { connectionId: $conn, agentId: $a, riskLevels: ["write", "destructive"] }, conditions: null }')"
existing="$(api GET "/companies/$cid/tools/policies" | jq '(.policies // .)')"
have="$(jq -c --arg n "$GH_BLOCK_POLICY" '[.[] | select(.name == $n)][0] // empty' <<<"$existing")"
if [[ -z "$have" ]]; then
  printf '%s' "$want" > "$WORK/p.json"; write POST "/companies/$cid/tools/policies" "$WORK/p.json" >/dev/null; log "  policy created: $GH_BLOCK_POLICY"
elif ! jq -e --argjson w "$want" '(.policyType == $w.policyType) and (.enabled == true) and (.priority == $w.priority)
         and ((.selectors | .riskLevels |= sort) == ($w.selectors | .riskLevels |= sort)) and (.conditions == $w.conditions)' <<<"$have" >/dev/null; then
  printf '%s' "$want" > "$WORK/p.json"; write PATCH "/companies/$cid/tools/policies/$(jq -r .id <<<"$have")" "$WORK/p.json" >/dev/null
  log "  policy updated (drifted): $GH_BLOCK_POLICY"
else
  log "  policy ok: $GH_BLOCK_POLICY"
fi
# probe TOOL PARAMS EXPECTED [REASON]: a real gateway test call as the marketer
probe() {
  local resp decision ar
  jq -n --arg a "$marketer" --arg t "$1" --argjson p "$2" '{agentId: $a, toolName: $t, parameters: $p}' > "$WORK/probe.json"
  resp="$(api POST "/tool-connections/$gh_conn/test-calls" "$WORK/probe.json")"
  decision="$(jq -r '.decision // "none"' <<<"$resp")"
  ar="$(jq -r '.actionRequestId // empty' <<<"$resp")"
  if [[ -n "$ar" ]]; then
    jq -n --arg c "$cid" '{companyId: $c, reason: "reliora-research probe; never meant to run"}' > "$WORK/decline.json"
    api POST "/tool-gateway/action-requests/$ar/decline" "$WORK/decline.json" >/dev/null
  fi
  [[ "$decision" == "$3" ]] || die "probe $1: expected $3, got $decision: $(head -c 300 <<<"$resp")"
  if [[ -n "${4:-}" ]]; then
    [[ "$(jq -r '.error.reasonCode // ""' <<<"$resp")" == "$4" ]] || die "probe $1: refused, but not by the policy (want $4): $(head -c 300 <<<"$resp")"
  fi
  log "  probe ok: $1 -> $decision${4:+ ($4)}"
}
if (( ! DRY )); then
  # a repository that does not exist, so nothing could be written even if the block failed
  probe create_branch '{"owner":"zz-governance-probe","repo":"none","branch":"probe"}' off deny_policy_block
  probe get_me '{}' allowed
  # the block keys on the catalog's risk: a mutating GitHub tool classified "read" would slip past it
  access="$(api GET "/tool-connections/$gh_conn/test-agents/$marketer/access")"
  misread="$(jq -r '[.access.tools[] | select(.risk == "read" and .decision != "off"
      and (.toolName | test("merge|push|fork|assign|dismiss|request_|create|update|delete|remove|add_|star|subscribe|write|trigger"; "i"))
      and (.toolName | test("^(get|list|search)_|_(read|get|list)$"; "i") | not))
      | .toolName] | join(", ")' <<<"$access")"
  [[ -z "$misread" ]] || die "GitHub tools that look mutating are classified read and stay open to the marketer: $misread"
  open_writes="$(jq -r '[.access.tools[] | select((.risk == "write" or .risk == "destructive") and .decision != "off") | .toolName] | join(", ")' <<<"$access")"
  [[ -z "$open_writes" ]] || die "GitHub write tools still open to the marketer: $open_writes"
  log "  GitHub: every write/destructive tool is off for the marketer; no mutating tool classified read"
  # Composio must not be a second GitHub write path
  gh_via_composio="$(api GET "/tool-connections/$cp_conn/composio/apps" | jq -r '[(.apps // [])[] | select((.toolkit | test("^github"; "i")) and .status != "not_connected") | .toolkit] | join(", ")')"
  [[ -z "$gh_via_composio" ]] || die "Composio has a GitHub toolkit connected ($gh_via_composio): the marketer could write to GitHub through it"
  log "  Composio: no GitHub toolkit connected"
fi

# the routines' skills; mode "add" keeps every other assigned skill
jq -n --argjson k "$(printf '%s\n' "${MARKETER_SKILLS[@]}" | jq -R . | jq -s .)" '{mode: "add", desiredSkills: $k}' > "$WORK/s.json"
skills="$(write POST "/agents/$marketer/skills/sync" "$WORK/s.json")"
if (( ! DRY )); then
  for k in "${MARKETER_SKILLS[@]}"; do
    # para-memory-files is a core skill the runtime may already carry ("external": the name is taken by
    # that installation, which is the same skill); for the routine skills, "external" would mean a stale
    # copy shadows them, so it fails.
    jq -e --arg k "$k" '[.entries[]? | select(.key == $k and .desired and (.state == "installed" or .state == "configured" or .state == "available"
        or (.state == "external" and $k == "paperclipai/paperclip/para-memory-files")))] | length == 1' <<<"$skills" >/dev/null \
      || die "marketer skill $k is not desired and resolved after sync (is the server image new enough to bundle it?): $(jq -c --arg k "$k" '[.entries[]? | select(.key == $k)]' <<<"$skills")"
  done
  log "  marketer skills: ${MARKETER_SKILLS[*]} desired"
  # retire the agent's private copies: unselect company/<cid>/<slug> so only the bundled skill loads
  retire="$(jq -c --arg cid "$cid" '[.entries[]? | .key as $k | select($k | startswith("company/" + $cid + "/"))
            | select(($k | split("/") | last | sub("-[0-9]+$"; "")) as $s | $ARGS.positional | index($s)) | select(.desired) | $k]' \
            --args "${RETIRED_SKILLS[@]}" <<<"$skills")"
  if [[ "$retire" != "[]" ]]; then
    jq -n --argjson k "$retire" '{mode: "remove", desiredSkills: $k}' > "$WORK/rs.json"
    skills="$(api POST "/agents/$marketer/skills/sync" "$WORK/rs.json")"
    log "  retired private copies: $(jq -r 'join(", ")' <<<"$retire")"
  fi
  jq -e --arg cid "$cid" '[.entries[]? | select(.key | startswith("company/" + $cid + "/")) | select(.desired)
        | select(.key | test("/(community-pain-blog|source-back-post)(-[0-9]+)?$"))] | length == 0' <<<"$skills" >/dev/null \
    || die "a private copy of community-pain-blog or source-back-post is still selected"
fi

# the seed task for the first research run
issues="$(api GET "/companies/$cid/issues?q=$(jq -rn --arg t "$SEED_TITLE" '$t|@uri')")"
seed="$(jq -r --arg t "$SEED_TITLE" '(if type == "object" then (.issues // .items) else . end) | [.[] | select(.title == $t)] | .[0].id // ""' <<<"$issues")"
if [[ -z "$seed" && -n "$SEED_DIR" ]]; then
  jq -n --arg t "$SEED_TITLE" --arg p "$pid" '{title: $t, projectId: $p, status: "done",
    description: "Holds the first Srenix capability notes (documents `summary` and `items`) for the first run of \"Reliora product research\". Nothing to do here."}' > "$WORK/i.json"
  seed="$(write POST "/companies/$cid/issues" "$WORK/i.json" | jq -r '.id // "DRY-RUN"')"; log "  seed task created: $seed"
fi
if [[ -n "$seed" && "$seed" != DRY-RUN && -n "$SEED_DIR" ]]; then
  for doc in summary:summary.md items:items.yaml; do
    key="${doc%%:*}"; file="$SEED_DIR/${doc#*:}"
    jq -n --rawfile b "$file" --arg t "${doc#*:}" '{title: $t, format: "markdown", body: $b, changeSummary: "seed"}' > "$WORK/d.json"
    if ! api GET "/issues/$seed/documents/$key" 2>/dev/null | jq -e --rawfile b "$file" '.body == $b' >/dev/null 2>&1; then
      write PUT "/issues/$seed/documents/$key" "$WORK/d.json" >/dev/null; log "  seed document written: $key"
    fi
    (( DRY )) || api GET "/issues/$seed/documents/$key" | jq -e --rawfile b "$file" '.body == $b' >/dev/null || die "seed document $key does not read back"
  done
  log "  seed task verified: $seed"
elif [[ -z "$seed" ]]; then
  log "  WARNING: no '$SEED_TITLE' task and no SEED_DIR: the first research run starts from scratch"
fi

# ensure_routine TITLE DESC CRON LABEL -> sets LAST_RID
LAST_RID=""
ensure_routine() {
  local title="$1" desc="$2" cron="$3" label="$4" rid detail
  routines="$(api GET "/companies/$cid/routines")"
  rid="$(jq -r --arg t "$title" '[.[] | select(.title == $t and .status != "archived")] | .[0].id // ""' <<<"$routines")"
  jq -n --arg t "$title" --arg d "$desc" --arg a "$marketer" --arg p "$pid" '{title: $t, description: $d,
    assigneeAgentId: $a, projectId: $p, priority: "medium", status: "active",
    concurrencyPolicy: "skip_if_active", catchUpPolicy: "skip_missed"}' > "$WORK/r.json"
  if [[ -z "$rid" ]]; then
    rid="$(write POST "/companies/$cid/routines" "$WORK/r.json" | jq -r '.id // "DRY-RUN"')"; log "  $title: created $rid"
  else
    write PATCH "/routines/$rid" "$WORK/r.json" >/dev/null; log "  $title: updated $rid"
  fi
  if [[ "$rid" != DRY-RUN ]]; then
    detail="$(api GET "/routines/$rid")"
    # exactly one enabled schedule trigger, the wanted one: keep the first match (enabled), disable every other schedule
    keep="$(jq -r --arg c "$cron" --arg z "$TZ_NAME" '[.triggers[]? | select(.kind == "schedule" and .cronExpression == $c and .timezone == $z)]
              | (map(select(.enabled)) + map(select(.enabled | not)))[0].id // ""' <<<"$detail")"
    if [[ -z "$keep" ]]; then
      jq -n --arg c "$cron" --arg z "$TZ_NAME" --arg l "$label" '{kind: "schedule", label: $l, cronExpression: $c, timezone: $z, enabled: true}' > "$WORK/t.json"
      write POST "/routines/$rid/triggers" "$WORK/t.json" >/dev/null; log "  $title: trigger created ($label)"
    elif ! jq -e --arg k "$keep" '.triggers[] | select(.id == $k) | .enabled' <<<"$detail" >/dev/null; then
      echo '{"enabled": true}' > "$WORK/t.json"; write PATCH "/routine-triggers/$keep" "$WORK/t.json" >/dev/null; log "  $title: trigger re-enabled ($label)"
    fi
    for extra in $(jq -r --arg k "$keep" '.triggers[]? | select(.kind == "schedule" and .enabled and .id != $k) | .id' <<<"$detail"); do
      echo '{"enabled": false}' > "$WORK/t.json"; write PATCH "/routine-triggers/$extra" "$WORK/t.json" >/dev/null; log "  $title: extra schedule trigger $extra disabled"
    done
    if (( ! DRY )); then
      detail="$(api GET "/routines/$rid")"
      jq -e --arg t "$title" --arg a "$marketer" --arg p "$pid" --arg c "$cron" --arg z "$TZ_NAME" --arg d "$desc" '
        .title == $t and .assigneeAgentId == $a and .projectId == $p and .status == "active" and .priority == "medium"
        and .concurrencyPolicy == "skip_if_active" and .catchUpPolicy == "skip_missed" and .description == $d
        and ([.triggers[] | select(.kind == "schedule" and .enabled)] | length == 1)
        and ([.triggers[] | select(.kind == "schedule" and .enabled and .cronExpression == $c and .timezone == $z)] | length == 1)' \
        <<<"$detail" >/dev/null || die "$title: read-back does not match: $(jq -c '{title, status, priority, assigneeAgentId, projectId, concurrencyPolicy, catchUpPolicy, triggers: [.triggers[] | {cronExpression, timezone, enabled}]}' <<<"$detail")"
      log "  $title: verified; next run $(jq -r '[.triggers[] | select(.kind == "schedule")][0].nextRunAt' <<<"$detail")"
    fi
  fi
  LAST_RID="$rid"
}

ensure_routine "$RES_TITLE" "$RES_DESC" "$RES_CRON" "Mondays 05:00 PT"
ensure_routine "$SCAN_TITLE" "$SCAN_DESC" "$SCAN_CRON" "daily 06:00 PT"
ensure_routine "$BACK_TITLE" "$BACK_DESC" "$BACK_CRON" "daily 09:30 PT"
log "done"
