#!/usr/bin/env bash
# setup-reliora-content-calendar.sh — the owner's standing content practice for
# reliora.ai, as two Paperclip routines for Reliora's Content Marketer
# (reports to the CMO), idempotently:
#
#   Blog on reliora.ai           Sunday and Tuesday 08:00 PT, one blog per day
#   Reliora Inc LinkedIn page    the next day, Monday / Wednesday 09:00 PT
#   Salil Kadam personal repost  the same Monday / Wednesday 12:00 PT, a short
#                                blurb with the live company post's link
#
#   1. "Reliora content calendar"         daily 07:00 PT: new Ghost drafts are
#      brought to the house style, scheduled into the next free Sunday/Tuesday,
#      and each gets its company LinkedIn post for the next day; a safety check
#      pulls any LinkedIn post whose blog is not live.
#   2. "Reliora content calendar: repost" Mon/Wed 09:30 and 11:30 PT: once a
#      company post is live, the personal repost is prepared.
#   Separate routines because a run waits in_review for the board's approvals
#   and skip_if_active would otherwise skip the Monday/Wednesday repost.
#   3. "Reliora content calendar: new draft" — the same steps, run as soon as Ghost
#      reports a new post (Ghost webhook "Post created" -> this routine's webhook
#      trigger), so the board's approval cards and #reliora-board note arrive
#      within minutes of a draft landing. always_enqueue: a draft that arrives
#      while an earlier batch waits for approval is not skipped. Signing mode
#      "ghost_hmac": Paperclip verifies Ghost's X-Ghost-Signature, so only Ghost
#      (holding the secret) can start a run. The webhook URL and secret are
#      written to WEBHOOK_URL_FILE (0600), never printed; add them in Ghost
#      admin: Settings > Integrations > custom integration > Add webhook,
#      event "Post created", Target URL + Secret from that file.
#   4. pauses Reliora's older "Daily blog -> LinkedIn" routine, which would
#      otherwise compete for the same drafts;
#   5. reads everything back and fails if any value differs.
#
# Every go-live (scheduling a blog, a company post, a repost) stays a board
# approval card (Ghost + TryPost ask-first policies); the board approves with
# "Approve all" on the task, and a note goes to #reliora-board.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key (`paperclipai token board create --ttl-days 1`). Never on a command line.
#
# Optional: WEBHOOK_URL_FILE (default ~/.reliora-ghost-webhook, mode 0600).
#
# Usage: deploy/scripts/setup-reliora-content-calendar.sh [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
COMPANY="Reliora Inc"
TZ_NAME="America/Los_Angeles"
OLD_ROUTINE="Daily blog -> LinkedIn"
CAL_TITLE="Reliora content calendar"
CAL_CRON="0 7 * * *"
REP_TITLE="Reliora content calendar: repost"
REP_CRON="30 9,11 * * 1,3"
NEW_TITLE="Reliora content calendar: new draft"
WEBHOOK_URL_FILE="${WEBHOOK_URL_FILE:-$HOME/.reliora-ghost-webhook}"
DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,42p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[reliora-calendar] $*" >&2; }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"

api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-reliora-calendar/1' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}
write() { if (( DRY )); then log "  DRY-RUN would $1 $2"; echo '{}'; else api "$@"; fi; }

read -r -d '' CAL_DESC <<'EOF' || true
The owner's standing content practice for reliora.ai. Use the **trypost** skill (tool gateway) and the
Ghost blog tools (`gh_*`, tenant `reliora`). Times are America/Los_Angeles.

| What | When |
|---|---|
| Blog publishes on reliora.ai | **Sunday and Tuesday, 08:00**, one blog per day |
| Reliora Inc LinkedIn page post (account "Reliora Inc", linkedin-page) | the **next day**: Monday (Sunday's blog), Wednesday (Tuesday's blog), **09:00** |
| Salil Kadam personal repost | handled by the routine "Reliora content calendar: repost" |

Every go-live (scheduling a blog, scheduling a LinkedIn post) returns `approval_required` and adds a card
to this task: that is expected. Request each once, never retry. The board approves with **Approve all**.

## A. New drafts: bring them to the house style

1. `gh_list_posts` with `status: "draft"`, all pages. Skip drafts tagged `#calendar` (their schedule is
   already requested and waiting for the board). Skip drafts that are not ready (empty body, title with
   TODO, WIP or TEST, or marked do-not-publish) and say so in the task.
2. Read two published posts as the style reference: `gh_get_post` on slugs
   `we-are-looking-for-our-first-design-partners` and `expiring-certificates-outage`.
3. Check each draft against the house style, and fix it with `gh_update_post` (`html`, drafts only):
   - 1 or 2 short opening paragraphs, then at least 3 `<h2>` sections with clear headings. No `<h1>`.
   - Steps, causes or stages as `<ol class="steps">` cards (`<li><span class="sn">01</span><div><h3>…</h3><p>…</p></div></li>`);
     checklists or benefits as `<ul class="ticks">`; one key caveat or takeaway as `<p class="note-i">`;
     commands in `<div class="post-code"><div class="cl">label</div><pre><code>…</code></pre></div>`.
     Wrap each such component in `<!--kg-card-begin: html-->` … `<!--kg-card-end: html-->`.
   - No hard-wrapped lines (a `<br>` in the middle of a paragraph), no raw URL as link text (use words),
     no link to any `*.baisoln.com` address, no "first 100" (say "limited places").
   - A custom excerpt of 1 or 2 sentences (300 characters at most), and 2 or 3 public tags.
     Never a public `linkedin` tag.
   - Keep the author's meaning, facts and voice. Change structure and formatting only. Never invent
     claims, numbers, customers or quotes. Record what you changed, per post, in the task.

## B. Schedule each ready draft into the blog calendar

1. Find the taken publish days: `gh_list_posts` with `status: "scheduled"` and `status: "published"`.
2. Give each ready draft, oldest first, the next **Sunday or Tuesday** after today at 08:00
   America/Los_Angeles that has no scheduled or published post. One blog per day.
   Days already promised to drafts tagged `#calendar` count as taken (see the task that requested them).
3. Request it: `gh_publish_post` with `post_id` and `published_at` (ISO 8601 with offset, e.g.
   `2026-11-01T08:00:00-08:00`). The approved call schedules it; it appears on reliora.ai at that time.
4. Tag the draft `#calendar` right away (`gh_update_post`, tags = existing + `#calendar`, with the `#`), so no
   other run requests it again. If the board rejects the schedule, remove `#calendar` so it can be retried.

## C. Company LinkedIn post for each scheduled blog

For each blog that is scheduled or published and does **not** carry the Ghost tag `#linkedin`:
1. Guard: `list-posts-tool` with `search` = the blog slug and `channels` = [Reliora Inc page id]. A hit means
   it already has its post: tag it `#linkedin` (step 4) and move on.
2. Draft the post (`create-post-tool`, account "Reliora Inc", `status: "draft"`): a hook line, a 2 to 4 sentence
   summary, the takeaway, the link `https://reliora.ai/blog/<slug>` (never the Ghost host), 3 to 5 hashtags.
   Check it with `preview-post-tool`.
3. Request it: `update-post-tool` with `status: "scheduled"` and `scheduled_at` = the day after the blog's publish
   day (Monday for Sunday, Wednesday for Tuesday) at 09:00 America/Los_Angeles, in UTC.
4. Tag the blog `#linkedin`: `gh_update_post` with tags = its existing tags + `#linkedin`. The tag is exactly
   `#linkedin` with the `#` (internal). Never send `linkedin` without the `#`: it shows publicly on reliora.ai.

## D. Safety check

For every Reliora Inc page post scheduled within the next 36 hours that links `reliora.ai/blog/<slug>`: if that
blog is not published, or not scheduled to publish before the post, pull the post back with `update-post-tool`
`status: "draft"` and say so. A post must never link a blog that is not live.

## E. Report

If you requested anything, post one note to the board per the **board-approval-notify** skill (#reliora-board):
the task link, each blog with its publish day and each company post with its time, and "Approve all on this task".
Then set the task to `in_review` and end the run. Nothing new: comment "No new drafts" and mark the task done.
After the board's decision, check the result (`gh_get_post` status `scheduled`, `get-post-tool` status
`scheduled`), record it, and mark the task done.
EOF

read -r -d '' REP_DESC <<'EOF' || true
The personal repost step of the Reliora content calendar. Use the **trypost** skill (tool gateway).
Times are America/Los_Angeles.

1. `list-posts-tool` with `channels` = [Reliora Inc page id] and `status: "published"`. Take the posts
   published in the last 3 days whose text links `https://reliora.ai/blog/` and that have a `platform_url`.
2. For each, check for an existing personal post: `list-posts-tool` with `channels` = [Salil Kadam profile id]
   and `search` = the blog slug, then with `search` = the company post's `platform_url`. Any hit (any status):
   it already has one, skip it.
3. Otherwise draft the repost (`create-post-tool`, account "Salil Kadam" linkedin profile, `status: "draft"`):
   a short, catchy blurb of 2 or 3 sentences in first person (different from the company text, no more than
   2 hashtags), then the company post's `platform_url` on its own last line so LinkedIn shows it as a card.
   Check it with `preview-post-tool`.
4. Request it once: `update-post-tool` with `status: "scheduled"` and `scheduled_at` = 12:00 America/Los_Angeles
   today (in UTC) if that is at least 20 minutes away, otherwise 30 minutes from now. It returns
   `approval_required`; that is expected.
5. If you requested anything, post one note per the **board-approval-notify** skill (#reliora-board) with the
   task link ("Personal repost ready: Approve on this task"), set the task to `in_review` and end the run.
   Nothing to do: comment "No new company post to repost" and mark the task done.
6. After the board's decision: check with `get-post-tool` (status `scheduled`), record it, mark the task done.
   Rejected: put the post back to `draft`, record the reason, mark the task done.
EOF

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

# ensure_routine TITLE DESC CRON LABEL -> routine id on stdout
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
    if ! jq -e --arg c "$cron" --arg z "$TZ_NAME" '[.triggers[]? | select(.kind == "schedule" and .cronExpression == $c and .timezone == $z)] | length == 1' <<<"$detail" >/dev/null; then
      jq -n --arg c "$cron" --arg z "$TZ_NAME" --arg l "$label" '{kind: "schedule", label: $l, cronExpression: $c, timezone: $z, enabled: true}' > "$WORK/t.json"
      write POST "/routines/$rid/triggers" "$WORK/t.json" >/dev/null; log "  $title: trigger created ($label)"
    fi
    if (( ! DRY )); then
      detail="$(api GET "/routines/$rid")"
      jq -e --arg a "$marketer" --arg p "$pid" --arg c "$cron" --arg z "$TZ_NAME" --arg d "$desc" '
        .assigneeAgentId == $a and .projectId == $p and .status == "active" and .concurrencyPolicy == "skip_if_active"
        and .description == $d
        and ([.triggers[] | select(.kind == "schedule" and .enabled and .cronExpression == $c and .timezone == $z)] | length == 1)' \
        <<<"$detail" >/dev/null || die "$title: read-back does not match: $(jq -c '{status, assigneeAgentId, projectId, concurrencyPolicy, triggers: [.triggers[] | {cronExpression, timezone, enabled}]}' <<<"$detail")"
      log "  $title: verified; next run $(jq -r '[.triggers[] | select(.kind == "schedule")][0].nextRunAt' <<<"$detail")"
    fi
  fi
}

ensure_routine "$CAL_TITLE" "$CAL_DESC" "$CAL_CRON" "daily 07:00 PT"
ensure_routine "$REP_TITLE" "$REP_DESC" "$REP_CRON" "Mon/Wed 09:30 and 11:30 PT"

# 3. on a new Ghost post: the same steps, now, via a webhook trigger
NEW_DESC="Ghost reported a new post on the Reliora blog. Run the calendar now, so the board's approval cards and the #reliora-board note arrive within minutes of a draft landing.

$CAL_DESC"
routines="$(api GET "/companies/$cid/routines")"
nid="$(jq -r --arg t "$NEW_TITLE" '[.[] | select(.title == $t and .status != "archived")] | .[0].id // ""' <<<"$routines")"
jq -n --arg t "$NEW_TITLE" --arg d "$NEW_DESC" --arg a "$marketer" --arg p "$pid" '{title: $t, description: $d,
  assigneeAgentId: $a, projectId: $p, priority: "high", status: "active",
  concurrencyPolicy: "always_enqueue", catchUpPolicy: "skip_missed"}' > "$WORK/n.json"
if [[ -z "$nid" ]]; then
  nid="$(write POST "/companies/$cid/routines" "$WORK/n.json" | jq -r '.id // "DRY-RUN"')"; log "  $NEW_TITLE: created $nid"
else
  write PATCH "/routines/$nid" "$WORK/n.json" >/dev/null; log "  $NEW_TITLE: updated $nid"
fi
if [[ "$nid" != DRY-RUN ]]; then
  detail="$(api GET "/routines/$nid")"
  if jq -e '[.triggers[]? | select(.kind == "webhook")] | length >= 1' <<<"$detail" >/dev/null; then
    log "  $NEW_TITLE: webhook trigger exists (URL kept in $WEBHOOK_URL_FILE from its creation)"
  else
    jq -n '{kind: "webhook", label: "Ghost: Post created", signingMode: "ghost_hmac", replayWindowSec: 300, enabled: true}' > "$WORK/w.json"
    created="$(write POST "/routines/$nid/triggers" "$WORK/w.json")"
    if (( ! DRY )); then
      url="$(jq -r '.secretMaterial.webhookUrl // empty' <<<"$created")"
      secret="$(jq -r '.secretMaterial.webhookSecret // empty' <<<"$created")"
      [[ "$url" == https://* ]] || die "$NEW_TITLE: webhook trigger created without an https URL"
      [[ -n "$secret" ]] || die "$NEW_TITLE: webhook trigger created without a signing secret"
      ( umask 077; printf 'Ghost admin > Settings > Integrations > custom integration > Add webhook\nEvent: Post created\nTarget URL: %s\nSecret: %s\n' "$url" "$secret" > "$WEBHOOK_URL_FILE" )
      unset secret
      log "  $NEW_TITLE: webhook trigger created; URL and secret written to $WEBHOOK_URL_FILE (0600)"
    fi
  fi
  if (( ! DRY )); then
    detail="$(api GET "/routines/$nid")"
    jq -e --arg a "$marketer" --arg d "$NEW_DESC" '.assigneeAgentId == $a and .status == "active"
      and .concurrencyPolicy == "always_enqueue" and .description == $d
      and ([.triggers[] | select(.kind == "webhook" and .enabled and .signingMode == "ghost_hmac")] | length == 1)' <<<"$detail" >/dev/null \
      || die "$NEW_TITLE: read-back does not match: $(jq -c '{status, concurrencyPolicy, triggers: [.triggers[] | {kind, enabled, signingMode}]}' <<<"$detail")"
    log "  $NEW_TITLE: verified"
  fi
fi

# the older daily routine would compete for the same drafts
routines="$(api GET "/companies/$cid/routines")"
old="$(jq -r --arg t "$OLD_ROUTINE" '[.[] | select(.title == $t and .status != "archived")] | .[0] // empty | .id + " " + .status' <<<"$routines")"
if [[ -n "$old" ]]; then
  read -r oid ostatus <<<"$old"
  if [[ "$ostatus" != paused ]]; then
    jq -n '{status: "paused"}' > "$WORK/o.json"; write PATCH "/routines/$oid" "$WORK/o.json" >/dev/null
  fi
  (( DRY )) || [[ "$(api GET "/routines/$oid" | jq -r .status)" == paused ]] || die "could not pause '$OLD_ROUTINE' ($oid)"
  log "  '$OLD_ROUTINE' ($oid): paused"
fi
log "done"
