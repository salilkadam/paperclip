#!/usr/bin/env bash
# setup-reliora-content-calendar.sh — the owner's standing content practice for
# reliora.ai, as two Paperclip routines for Reliora's Content Marketer
# (reports to the CMO), idempotently:
#
#   Blog on reliora.ai           Sunday and Tuesday 08:00 PT, one blog per day
#   Reliora Inc LinkedIn page    the next day, Monday / Wednesday 09:00 PT
#   Salil Kadam personal post    the same Monday / Wednesday 09:30 PT (company
#                                post + 30 min), first person, linking the blog
#
#   1. "Reliora content calendar" — ONE routine, ONE lane: it runs daily at
#      07:00 PT and whenever Ghost reports a new post (webhook "Post created",
#      signing mode ghost_hmac), with concurrencyPolicy coalesce_if_active so
#      two runs never work at once (2026-10-26: two parallel runs requested the
#      same six drafts with conflicting dates). New Ghost drafts are brought to
#      the house style, scheduled into the next free Sunday/Tuesday, and each
#      blog that Ghost reports scheduled or published gets its company LinkedIn
#      post for the day after its publish date; a safety check pulls any
#      LinkedIn post whose blog is not live by then. A draft that lands while a
#      run waits for the board is picked up when the board's decision wakes the
#      agent, or at the next 07:00 run.
#      The webhook URL and secret are written to WEBHOOK_URL_FILE (0600) when the
#      trigger is created, never printed; add them in Ghost admin: Settings >
#      Integrations > custom integration > Add webhook, event "Post created".
#   2. archives "Reliora content calendar: repost" (retired 2026-11-15): the
#      personal post is scheduled by the calendar together with the company post,
#      both linking the blog, so it no longer waits for the company post to go live.
#      Two routines creating personal posts with different links let duplicates
#      past each one's search (two personal posts for the same blog, Nov 2026).
#   3. archives the retired "Reliora content calendar: new draft" routine if one
#      still exists, and pauses Reliora's older "Daily blog -> LinkedIn" routine.
#   4. reads everything back and fails if any value differs.
#
# No board approval (owner, 2026-11-15): Reliora is a direct-publish company
# (lib/direct-publish.sh), so scheduling a blog or a LinkedIn post runs directly;
# run setup-trypost-governance.sh, setup-ghost-governance.sh and
# setup-ghost-connections.sh after changing that list. Delete, unpublish and
# publish-now stay ask-first.
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
NEW_TITLE="Reliora content calendar: new draft"
WEBHOOK_URL_FILE="${WEBHOOK_URL_FILE:-$HOME/.reliora-ghost-webhook}"
DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
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
Ghost blog tools (`gh_*`): pass `tenant_id: "reliora"` in EVERY `gh_*` call. Times are America/Los_Angeles.
This routine runs daily at 07:00 and whenever Ghost reports a new post. Only one run is active at a time.

**No board approval (owner decision, 2026-11-15).** Scheduling a blog (`gh_publish_post`) and creating,
editing or scheduling a LinkedIn post (`create-post-tool`, `update-post-tool` with `status: "scheduled"`) run
directly. The trypost skill's "draft, then ask the board" step does not apply to Reliora. If the board dislikes a
post, the owner removes it by hand. Still gated, and not needed for this routine: publish-now, delete, unpublish.

| What | When |
|---|---|
| Blog publishes on reliora.ai | **Sunday and Tuesday, 08:00**, one blog per day |
| Reliora Inc LinkedIn page post (account "Reliora Inc", linkedin-page) | the **next day**: Monday (Sunday's blog), Wednesday (Tuesday's blog), **09:00** |
| Salil Kadam personal post (account "Salil Kadam", linkedin) | the same day, **09:30** (company post + 30 minutes) |

Both LinkedIn posts link the blog at `https://reliora.ai/blog/<slug>`, so the blog is always live first, then
the company post, then the personal post.

**One of each per blog, ever.** A blog gets exactly one Reliora Inc page post and exactly one Salil Kadam post.
Before you create any LinkedIn post, search that account for the blog slug with `list-posts-tool`
(`channels` = [that account's id], `search` = the slug) once for EACH status: draft, scheduled,
pending_approval, published, failed. Any hit means the post exists: use it (section C), never create another.
Every post you create contains the full blog link, so this search always finds it.

## A. New drafts: bring them to the house style

1. `gh_list_posts` with `status: "draft"`, all pages. Skip drafts tagged `#calendar` (already scheduled once).
   Skip drafts that are not ready (empty body, title with TODO, WIP or TEST, or marked do-not-publish) and say
   so in the task.
2. Read two published posts as the style reference: `gh_get_post` on slugs
   `we-are-looking-for-our-first-design-partners` and `expiring-certificates-outage`.
3. Check each draft against the house style, and fix it with `gh_update_post` (`html`, drafts only):
   - 1 or 2 short opening paragraphs, then at least 3 `<h2>` sections with clear headings. No `<h1>`.
   - Steps, causes or stages as `<ol class="steps">` cards (`<li><span class="sn">01</span><div><h3>…</h3><p>…</p></div></li>`);
     checklists or benefits as `<ul class="ticks">`; one key caveat or takeaway as `<p class="note-i">`
     (a draft from the community scan already ends with its product note as the one `note-i`: keep it unchanged);
     commands in `<div class="post-code"><div class="cl">label</div><pre><code>…</code></pre></div>`.
     Wrap each such component in `<!--kg-card-begin: html-->` … `<!--kg-card-end: html-->`.
   - Visuals (the **blog-visuals** skill): a hero image (`feature_image`) always, and a workflow diagram
     figure where the post describes a process. Add whichever is missing; never replace existing ones.
   - No hard-wrapped lines (a `<br>` in the middle of a paragraph), no raw URL as link text (use words),
     no link to any `*.baisoln.com` address, no "first 100" (say "limited places").
   - A custom excerpt of 1 or 2 sentences (300 characters at most), and 2 or 3 public tags.
     Never a public `linkedin` tag.
   - Keep the author's meaning, facts and voice. Change structure and formatting only. Never invent
     claims, numbers, customers or quotes. Record what you changed, per post, in the task.
4. A draft that repeats a scheduled or published blog (the same failure and root cause) is not scheduled: say
   so in the task, tag it `#duplicate`, and leave it for a person.

## B. Schedule each ready draft into the blog calendar

1. Find the taken publish days: `gh_list_posts` with `status: "scheduled"` and `status: "published"`, all pages.
   Write the list of taken dates (YYYY-MM-DD, Pacific) in the task before choosing.
2. Give each ready draft, oldest first, the next **Sunday or Tuesday** after today at 08:00
   America/Los_Angeles that is NOT in that list. One blog per day.
3. Schedule it: `gh_publish_post` with `tenant_id: "reliora"`, `post_id` and `published_at` (ISO 8601 with the
   offset for THAT date: `-08:00` from the first Sunday of November until the second Sunday of March (that
   Sunday's 08:00 is already `-07:00`), `-07:00` the rest of the year; e.g. `2026-11-03T08:00:00-08:00`,
   `2027-03-14T08:00:00-07:00`). It runs directly.
4. Check it with `gh_get_post` (status `scheduled`, the date you chose), then tag the post `#calendar`
   (`gh_update_post`, tags = existing + `#calendar`, with the `#`).

## C. The two LinkedIn posts for each scheduled or published blog

For EVERY blog whose Ghost status is **scheduled** or **published** right now (`gh_get_post`; never assume),
published or due within the last 7 days or later, check BOTH accounts with the search rule above, whether or not
the blog carries `#linkedin`: the tag is only a marker, never proof that both posts exist (a blog tagged by an
older process had a company post and no personal post). Create only what is missing. For each:
1. Company post day: the day after the blog's `published_at` as Ghost reports it (Monday for a Sunday blog,
   Wednesday for a Tuesday blog), 09:00 America/Los_Angeles in UTC (16:00Z while US daylight time applies,
   17:00Z from the first Sunday of November: Mon 2 Nov 09:00 = 17:00Z). Personal post: that time + 30 minutes.
   A blog published more than 7 days ago gets no new LinkedIn posts: tag it `#linkedin` and say so.
   Never schedule a time that has already passed (a past `scheduled_at` posts at once). If the company time
   has passed, use the next Monday or Wednesday 09:00 that no other company post holds, and the personal post
   30 minutes after it.
2. Company post (account "Reliora Inc"). Search first (the rule above). If none exists: `create-post-tool`
   with `status: "draft"`: a hook line, a 2 to 4 sentence summary, the takeaway, the link
   `https://reliora.ai/blog/<slug>` (never the Ghost host), 3 to 5 hashtags. Attach the blog's hero
   (**blog-visuals** section 3: `attach-media-from-url-tool`, `urls: [{"url": "https://reliora.ai/blog-media/<path>", "alt": "..."}]`)
   and check it with `preview-post-tool`. Then schedule it: `update-post-tool` with `status: "scheduled"` and
   `scheduled_at` from step 1. If the search found a draft for this blog, schedule that draft instead; if it found a
   scheduled one at another time, move it to the right time with `update-post-tool`.
3. Personal post (account "Salil Kadam"). Search first. If none exists: `create-post-tool` with
   `status: "draft"`: 2 or 3 short sentences in first person, Salil's own take (different words from the company
   post), at most 2 hashtags, and `https://reliora.ai/blog/<slug>` on its own last line. Check it with
   `preview-post-tool`, then schedule it at the company time + 30 minutes. A found draft or a post at another time
   is scheduled or moved the same way as in step 2.
4. Check both with `get-post-tool` (status `scheduled`, the right times), then tag the blog `#linkedin`:
   `gh_update_post` with tags = its existing tags + `#linkedin` (exactly `#linkedin`, with the `#`; without the
   `#` it shows publicly on reliora.ai).

## D. Safety and duplicate check

1. For every scheduled Reliora Inc or Salil Kadam post that links `reliora.ai/blog/<slug>`: check the blog with
   `gh_get_post`. If it is not published, or not scheduled to publish at least 12 hours before the post, pull
   the post back with `update-post-tool` `status: "draft"` and say so. A post must never link a blog that is not
   live. Section C schedules it again once the blog is scheduled.
2. For each account SEPARATELY, group that account's posts that are not published by blog slug. More than one
   post on the SAME account for the same slug is a duplicate. One Reliora Inc post plus one Salil Kadam post for a
   blog is the correct pair, never a duplicate: keep the scheduled one (or the oldest, if none is scheduled), pull the others to `draft`, and
   list them in the task under "Duplicates to delete" (account, first line, time). Request `delete-post-tool`
   for each duplicate draft at most ONCE: if a delete for that post already waits for approval on any open
   task, do not request it again.

## E. Report

Comment in plain words (the **board-plain-language** skill): each blog with its publish day and link, and each
LinkedIn post with its account, time and first line in quotes. Never put a raw id in the main text (a last
"For the record:" line only). No board note is needed for scheduling. Mark the task done. Only when something
failed (a tool error, a blog that cannot be scheduled) post one note to #reliora-board per the
**board-approval-notify** skill and set the task `in_review`.
Nothing new: comment "No new drafts" and mark the task done.
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

# ensure_routine TITLE DESC CRON LABEL CONCURRENCY -> sets LAST_RID
LAST_RID=""
ensure_routine() {
  local title="$1" desc="$2" cron="$3" label="$4" conc="$5" rid detail
  routines="$(api GET "/companies/$cid/routines")"
  rid="$(jq -r --arg t "$title" '[.[] | select(.title == $t and .status != "archived")] | .[0].id // ""' <<<"$routines")"
  jq -n --arg t "$title" --arg d "$desc" --arg a "$marketer" --arg p "$pid" --arg c "$conc" '{title: $t, description: $d,
    assigneeAgentId: $a, projectId: $p, priority: "medium", status: "active",
    concurrencyPolicy: $c, catchUpPolicy: "skip_missed"}' > "$WORK/r.json"
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
      jq -e --arg a "$marketer" --arg p "$pid" --arg c "$cron" --arg z "$TZ_NAME" --arg d "$desc" --arg k "$conc" '
        .assigneeAgentId == $a and .projectId == $p and .status == "active" and .concurrencyPolicy == $k
        and .description == $d
        and ([.triggers[] | select(.kind == "schedule" and .enabled and .cronExpression == $c and .timezone == $z)] | length == 1)' \
        <<<"$detail" >/dev/null || die "$title: read-back does not match: $(jq -c '{status, assigneeAgentId, projectId, concurrencyPolicy, triggers: [.triggers[] | {cronExpression, timezone, enabled}]}' <<<"$detail")"
      log "  $title: verified; next run $(jq -r '[.triggers[] | select(.kind == "schedule")][0].nextRunAt' <<<"$detail")"
    fi
  fi
  LAST_RID="$rid"
}

ensure_routine "$CAL_TITLE" "$CAL_DESC" "$CAL_CRON" "daily 07:00 PT" "coalesce_if_active"
cal_id="$LAST_RID"

# the repost routine is retired into the calendar (see the header)
routines="$(api GET "/companies/$cid/routines")"
rep_id="$(jq -r --arg t "$REP_TITLE" '[.[] | select(.title == $t and .status != "archived")] | .[0].id // ""' <<<"$routines")"
if [[ -n "$rep_id" ]]; then
  jq -n '{status: "archived"}' > "$WORK/x.json"; write PATCH "/routines/$rep_id" "$WORK/x.json" >/dev/null
  (( DRY )) || [[ "$(api GET "/routines/$rep_id" | jq -r .status)" == archived ]] || die "could not archive '$REP_TITLE' ($rep_id)"
  log "  '$REP_TITLE' ($rep_id): archived (retired into '$CAL_TITLE')"
fi

# the Ghost webhook: on the calendar routine itself, so it shares the one lane
if [[ "$cal_id" != DRY-RUN ]]; then
  detail="$(api GET "/routines/$cal_id")"
  if jq -e '[.triggers[]? | select(.kind == "webhook" and .signingMode == "ghost_hmac")] | length >= 1' <<<"$detail" >/dev/null; then
    log "  $CAL_TITLE: Ghost webhook trigger exists (URL and secret kept in $WEBHOOK_URL_FILE from its creation)"
  else
    jq -n '{kind: "webhook", label: "Ghost: Post created", signingMode: "ghost_hmac", replayWindowSec: 300, enabled: true}' > "$WORK/w.json"
    created="$(write POST "/routines/$cal_id/triggers" "$WORK/w.json")"
    if (( ! DRY )); then
      url="$(jq -r '.secretMaterial.webhookUrl // empty' <<<"$created")"
      secret="$(jq -r '.secretMaterial.webhookSecret // empty' <<<"$created")"
      [[ "$url" == https://* ]] || die "$CAL_TITLE: webhook trigger created without an https URL"
      [[ -n "$secret" ]] || die "$CAL_TITLE: webhook trigger created without a signing secret"
      ( umask 077; printf 'Ghost admin > Settings > Integrations > custom integration > Add webhook\nEvent: Post created\nTarget URL: %s\nSecret: %s\n' "$url" "$secret" > "$WEBHOOK_URL_FILE" )
      unset secret
      log "  $CAL_TITLE: Ghost webhook trigger created; URL and secret written to $WEBHOOK_URL_FILE (0600). Update Ghost admin."
    fi
  fi
  if (( ! DRY )); then
    detail="$(api GET "/routines/$cal_id")"
    jq -e '([.triggers[] | select(.kind == "webhook" and .enabled and .signingMode == "ghost_hmac")] | length == 1)' <<<"$detail" >/dev/null \
      || die "$CAL_TITLE: expected exactly one enabled ghost_hmac webhook trigger: $(jq -c '[.triggers[] | {kind, enabled, signingMode}]' <<<"$detail")"
    log "  $CAL_TITLE: one lane verified (schedule + Ghost webhook, coalesce_if_active)"
  fi
fi

# the retired separate webhook routine must not run in parallel with the calendar
routines="$(api GET "/companies/$cid/routines")"
retired="$(jq -r --arg t "$NEW_TITLE" '[.[] | select(.title == $t and .status != "archived")] | .[0].id // ""' <<<"$routines")"
if [[ -n "$retired" ]]; then
  jq -n '{status: "archived"}' > "$WORK/x.json"; write PATCH "/routines/$retired" "$WORK/x.json" >/dev/null
  log "  '$NEW_TITLE' ($retired): archived (retired; its webhook moved to '$CAL_TITLE')"
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
