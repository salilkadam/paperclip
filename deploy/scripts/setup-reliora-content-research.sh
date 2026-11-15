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
#      which formats and schedules it (Reliora publishes without board approval since
#      2026-11-15, deploy/scripts/lib/direct-publish.sh). The scan itself only
#      writes drafts, and skips a problem an existing post already covers.
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
# the GitHub connection the marketer researches through (renamed 2026-11-15 when
# product-research access was re-granted; override with GITHUB_CONN)
GITHUB_CONN="${GITHUB_CONN:-GitHub reliora}"
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
    proprietary) repo_lines+="  - \`$repo\` — **proprietary**: its code and design are \`internal\`, never blog material. Its capabilities may be shown as what the solution does: if it solves a problem, a blog may describe how the problem gets solved, without its code or design."$'\n' ;;
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
- Queue cap: 20 (see the skill for what counts). The queue may grow freely below the cap so the site never
  runs out of posts; the cap is only a backstop. At or above 20, bank the topic instead of drafting. There is
  no lower hard limit: do not block drafting at low counts.
- For every drafted or banked topic, record in the ledger: the exact source URL, the original post title, the
  author's public username/handle and the post date.
- Public contact disclosure flag (CLO ruling REL-3212, board-approved 2026-10-30; see
  `$AGENT_HOME/life/resources/source-outreach/clo-contact-rule.md`): for each topic, set
  `public-contact-disclosed=yes|no|unknown` in the ledger. Set `yes` only when the author published a contact
  route (email, personal-site link) **themselves** on their own profile or post; record that disclosure's
  source URL. Note the fact and the URL only — never copy the contact detail itself into the ledger, and never
  write anything into a CRM: a human (owner or COO) creates any CRM record from a flagged line. Pseudonym rule:
  the account shows no professional identity => `no`, no flag. Guessing/generating emails, email-finder or
  people-search tools, and bulk profile scraping stay banned. Keep new flags under ~10 per month; above that,
  flag it for the board before continuing.
- Source back-post link: note in the ledger that the "Reliora source back-post" routine drafts the reply to
  the source thread when the blog goes live.

- No repeats (owner, 2026-11-15): before drafting, list the blog's posts with `gh_list_posts` (`tenant_id:
  "reliora"`) for each of `status: "draft"`, `"scheduled"` and `"published"`, all pages. If any of them already
  covers the same problem (the same failure and root cause, whatever its title), do not draft it: record it in
  the ledger as `covered-by: <slug>` and take the next candidate.

At most one new **draft** (`status: "draft"`, sent explicitly). Do not publish or schedule it yourself: the
"Reliora content calendar" routine schedules it when Ghost reports the draft (no board approval since
2026-11-15). Finish with the shortlist and the draft's title (or why none), in plain words, and mark the task done.
EOF

read -r -d '' BACK_DESC <<'DESC' || true
Daily source back-post for reliora.ai. Use the **source-back-post** skill. Times are America/Los_Angeles.

- Ghost tenant `reliora`; public blog https://reliora.ai/blog/ . Ledger and reply log in
  `$AGENT_HOME/life/resources/blog-topics/` (`ledger.md`, `replies.md`). If they are missing there, copy them
  once from `/paperclip/instances/default/skills/62d63984-df6c-49be-981c-1273f68a451c/community-pain-blog/blog-topics/`.
- Priority: as soon as a blog goes live on reliora.ai, its OWN source thread is the first reply candidate that
  run, before any other thread. Check live-since-yesterday slugs against the ledger so the loop back to the
  source closes on day one.
- Owner's decisions (2026-10-28/29/30): every community reply is **posted by Salil from his own account** (for
  Reliora and Bionic alike); you only draft it. Threads:
  the blog's own source, and recent threads a live blog genuinely answers (relevance gate). Limits: 1 reply per
  thread, 1 per subreddit/site per 7 days, 2 per blog. The first two replies go to the CMO before the board.
  Queue depth never blocks a run (cap 20 is only a backstop; see the scan routine).
- Contact-detail rule (CLO ruling REL-3212, board-approved 2026-10-30; full rule in
  `$AGENT_HOME/life/resources/source-outreach/clo-contact-rule.md`): a reply draft may note, for the human,
  that the source author publicly disclosed a contact route on their own profile/post, with the disclosure
  source URL. Never copy the contact detail itself into a draft, and never write to a CRM; a human creates any
  CRM record from a flagged ledger line. Guessing emails, email-finder tools and profile scraping stay banned.
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

# GitHub: the marketer reads everything, and writes only pull requests to the
# website repo (owner decision 2026-11-15). Merging stays with a person: a merge
# to main deploys reliora.ai. Five block policies, all scoped to the marketer on
# this connection (a block applies when ALL its conditions match):
#   1. the write tools outside the PR workflow: always blocked;
#   2. the PR-workflow tools on any owner but Reliora-Inc;
#   3. the PR-workflow tools on any repo but reliora-website;
#   4./5./6. branch allow-list for branch and file writes: the branch must be a
#      string starting with "content/" (so never main, refs/heads/main, "" or a
#      missing/null branch that would land on the default branch, main). main
#      has no server-side protection on this GitHub plan, so this is the gate.
# Every write/destructive tool in the catalog must be in GH_PR_TOOLS or
# GH_BLOCKED_TOOLS; a new one stops the run until a person classifies it.
GH_PR_TOOLS='["create_branch","create_or_update_file","push_files","create_pull_request","update_pull_request","add_issue_comment"]'
GH_FILE_TOOLS='["create_branch","create_or_update_file","push_files"]'
GH_BLOCKED_TOOLS='["delete_file","actions_run_trigger","merge_pull_request","pull_request_review_write","update_issue_comment","request_copilot_review","sub_issue_write","update_pull_request_branch","add_comment_to_pending_review","issue_write","create_repository","fork_repository","add_reply_to_pull_request_comment"]'
desired_gh="$(jq -n --arg conn "$gh_conn" --arg a "$marketer" --arg n "$GH_BLOCK_POLICY" \
  --argjson pr "$GH_PR_TOOLS" --argjson files "$GH_FILE_TOOLS" --argjson blocked "$GH_BLOCKED_TOOLS" '
  def pol(name; desc; tools; cond): { name: name, description: desc, policyType: "block", priority: 40, enabled: true,
    selectors: { connectionId: $conn, agentId: $a, toolNames: tools }, conditions: cond };
  [ pol($n; "The content marketer never merges, deletes, triggers workflows, edits issues or reviews, or creates/forks repositories."; $blocked; null),
    pol("org-instructions: content marketer PRs only to Reliora-Inc"; "Pull-request tools are limited to the Reliora-Inc owner."; $pr; {arguments: {fieldNotEquals: {owner: "Reliora-Inc"}}}),
    pol("org-instructions: content marketer PRs only to reliora-website"; "Pull-request tools are limited to the reliora-website repository."; $pr; {arguments: {fieldNotEquals: {repo: "reliora-website"}}}),
    pol("org-instructions: content marketer branches start with content/"; "Branch names must start with content/ (e.g. content/new-blog-page). main deploys reliora.ai and is never written directly."; $files; {arguments: {fieldMatches: {branch: "^(?!content/)"}}}),
    pol("org-instructions: content marketer names a branch"; "A branch write without a branch lands on the default branch (main)."; $files; {arguments: {fieldAbsent: ["branch"]}}),
    pol("org-instructions: content marketer branch is never null"; "A null branch can fall back to the default branch (main)."; $files; {arguments: {fieldIn: {branch: [null]}}}) ]')"
existing="$(api GET "/companies/$cid/tools/policies" | jq '(.policies // .)')"
while read -r want; do
  name="$(jq -r .name <<<"$want")"
  have="$(jq -c --arg n "$name" '[.[] | select(.name == $n)][0] // empty' <<<"$existing")"
  if [[ -z "$have" ]]; then
    printf '%s' "$want" > "$WORK/p.json"; write POST "/companies/$cid/tools/policies" "$WORK/p.json" >/dev/null; log "  policy created: $name"
  elif ! jq -e --argjson w "$want" '(.policyType == $w.policyType) and (.enabled == true) and (.priority == $w.priority)
           and (.selectors.connectionId == $w.selectors.connectionId) and (.selectors.agentId == $w.selectors.agentId)
           and ((.selectors.toolNames // []) | sort) == ($w.selectors.toolNames | sort)
           and ((.selectors.riskLevels // []) == []) and (.conditions == $w.conditions)' <<<"$have" >/dev/null; then
    printf '%s' "$want" > "$WORK/p.json"; write PATCH "/companies/$cid/tools/policies/$(jq -r .id <<<"$have")" "$WORK/p.json" >/dev/null
    log "  policy updated (drifted): $name"
  else
    log "  policy ok: $name"
  fi
done < <(jq -c '.[]' <<<"$desired_gh")
# failed_upstream: the last allowed probe reached GitHub and GitHub refused it
failed_upstream() {
  jq -e '(.error != null and (.result == null or .result.content == null))
         or (.result.data.isError == true)
         or ((.result.content // "") | tostring | test("\"success\"\\s*:\\s*false"))' <<<"$PROBE_RESP" >/dev/null
}
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
  PROBE_RESP="$resp"
  log "  probe ok: $1 -> $decision${4:+ ($4)}"
}
if (( ! DRY )); then
  # a repository that does not exist, so nothing could be written even if the block failed
  # No probe below can change a repository even if its gate were broken: every
  # target owner, repo or branch does not exist. Each blocked probe trips one
  # policy only (fieldNotEquals/fieldMatches on the others pass).
  B="content/zz-governance-probe-no-such-branch"
  probe create_branch "{\"owner\":\"zz-governance-probe\",\"repo\":\"reliora-website\",\"branch\":\"$B\"}" off deny_policy_block   # policy 2 (owner)
  probe create_branch "{\"owner\":\"Reliora-Inc\",\"repo\":\"zz-governance-probe\",\"branch\":\"$B\"}" off deny_policy_block     # policy 3 (repo)
  probe merge_pull_request '{"owner":"zz-governance-probe","repo":"none","pullNumber":0}' off deny_policy_block                            # policy 1
  probe create_or_update_file '{"owner":"Reliora-Inc","repo":"reliora-website","branch":"zz-governance-probe-no-such-branch","path":"zz-probe","message":"probe","content":"cHJvYmU="}' off deny_policy_block   # policy 4 (prefix)
  probe push_files '{"owner":"Reliora-Inc","repo":"reliora-website","branch":"refs/heads/zz-governance-probe-no-such-branch","message":"probe","files":[]}' off deny_policy_block                       # policy 4 (refs/ form)
  # allowed, and must fail upstream (the branch does not exist), so nothing is written
  probe create_or_update_file "{\"owner\":\"Reliora-Inc\",\"repo\":\"reliora-website\",\"branch\":\"$B\",\"path\":\"zz-probe\",\"message\":\"probe\",\"content\":\"cHJvYmU=\"}" allowed
  failed_upstream || die "create_or_update_file probe ran upstream and did NOT fail: a real commit may exist on $B: $(head -c 400 <<<"$PROBE_RESP")"
  probe create_pull_request "{\"owner\":\"Reliora-Inc\",\"repo\":\"reliora-website\",\"head\":\"$B\",\"base\":\"main\",\"title\":\"governance probe\"}" allowed
  failed_upstream || die "create_pull_request probe ran upstream and did NOT fail: a real PR may exist: $(head -c 400 <<<"$PROBE_RESP")"
  # the null/absent-branch policies are not probed live (a broken gate could
  # fall back to main); their read-back above is the proof
  probe get_me '{}' allowed
  # the block keys on the catalog's risk: a mutating GitHub tool classified "read" would slip past it
  access="$(api GET "/tool-connections/$gh_conn/test-agents/$marketer/access")"
  misread="$(jq -r '[.access.tools[] | select(.risk == "read" and .decision != "off"
      and (.toolName | test("merge|push|fork|assign|dismiss|request_|create|update|delete|remove|add_|star|subscribe|write|trigger"; "i"))
      and (.toolName | test("^(get|list|search)_|_(read|get|list)$"; "i") | not))
      | .toolName] | join(", ")' <<<"$access")"
  [[ -z "$misread" ]] || die "GitHub tools that look mutating are classified read and stay open to the marketer: $misread"
  unclassified="$(jq -r --argjson pr "$GH_PR_TOOLS" --argjson blocked "$GH_BLOCKED_TOOLS" '[.access.tools[]
      | select(.risk == "write" or .risk == "destructive") | .toolName
      | select(. as $t | (($pr + $blocked) | index($t)) | not)] | join(", ")' <<<"$access")"
  [[ -z "$unclassified" ]] || die "GitHub write tools not classified as PR workflow or blocked: $unclassified (add them to GH_PR_TOOLS or GH_BLOCKED_TOOLS)"
  open_blocked="$(jq -r --argjson blocked "$GH_BLOCKED_TOOLS" '[.access.tools[] | select(.toolName as $t | $blocked | index($t)) | select(.decision != "off") | .toolName] | join(", ")' <<<"$access")"
  [[ -z "$open_blocked" ]] || die "GitHub tools that must be blocked are still open to the marketer: $open_blocked"
  log "  GitHub: marketer writes only content/* branches and PRs on Reliora-Inc/reliora-website (never main, never merge); every other write tool off"
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
