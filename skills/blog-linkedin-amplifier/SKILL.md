---
name: blog-linkedin-amplifier
description: Daily marketing routine — pick one new draft blog on your company's Ghost site, prepare its company-page LinkedIn post and a personal-profile post in TryPost, and hand all three go-live actions to the board as one decision. Never repeats a blog. Use when a routine or task asks you to publish/promote the day's blog on LinkedIn.
---

# Blog → LinkedIn amplifier

One run handles **one blog**. Nothing goes public until the board approves it.
You prepare everything as drafts and then request three go-live actions in the
same run. The board approves them together with **Approve all** on your task.

Read the `trypost` skill first. It explains how to reach TryPost through the
Paperclip tool gateway and the drafting rules. Ghost tools (`gh_*`) come from your
company's **Ghost blog** connection on the same gateway; search for them there.

## Inputs (from the routine description)

- Ghost `tenant_id` (`bionic` or `reliora`) and the public blog base URL.
- The company LinkedIn page (display name), e.g. `Reliora Inc`.
- The personal LinkedIn profile for the repost, e.g. `Salil Kadam`. This is the
  only personal profile you may post to. The task names it.
- The board Slack channel, if one is set.

If one is missing, stop. Put the run in `blocked`, name the missing input, and
end the run.

## Ledger: never repeat a blog

Ghost **internal tags** on the blog are the durable record. Readers never see them.

| Tag | Meaning |
|---|---|
| `#linkedin-pending` | Picked, go-live requested, waiting for the board |
| `#linkedin-shared` | Published and both LinkedIn posts scheduled |

`gh_update_post` **replaces** the tag list. Always send the existing tags
plus or minus the one you change.

## Steps

1. **Check for unfinished work.** If a blog already carries `#linkedin-pending`,
   do not pick a new one. Finish that one with step 9 instead.
2. **Find candidates.** `gh_list_posts` with `status: "draft"`, all pages.
   Drop every post tagged `#linkedin-pending` or `#linkedin-shared`. Also drop
   posts that are not ready: an empty body, a title with "TODO" or "WIP", or
   anything the task says to skip. No candidates: comment "No new blog today",
   mark the run `done`, and end.
3. **Pick the most exciting one.** Read the candidates (`gh_get_post`). Pick
   on timeliness, a concrete outcome or number, relevance to the company's
   buyers, and a strong hook. Prefer posts created since the last run. In
   the task, give one sentence on why you picked it.
4. **Second guard.** `list-posts-tool` in TryPost: search the company page and
   the personal profile for the blog's slug or URL, any status. A hit means it
   was already shared. Tag the blog `#linkedin-shared`, go back to step 3, and
   pick another.
5. **Draft both LinkedIn posts** (`create-post-tool`, `status: "draft"`
   explicitly; never `scheduled_at` while drafting):
   - **Company page:** a hook line, a 2–4 sentence summary, and the takeaway.
     Link to `<blog base URL>/<slug>/`, the public URL after publish (not the
     draft preview URL). Add 3–5 relevant hashtags. Stay under the
     account's `max_content_length`.
   - **Personal profile:** different text, first person, a short point of view
     on why it matters, and the same link. Do not paste the company post.
   - Check both with `preview-post-tool`.
6. **Mark it pending.** `gh_update_post` with tags = existing + `#linkedin-pending`.
7. **Request go-live: three calls in this run, one each, no retries:**
   1. `gh_publish_post` with the post id (no `published_at`; it publishes on approval).
   2. `update-post-tool` on the company post: `status: "scheduled"`,
      `scheduled_at` = the next weekday 09:00 in the account timezone,
      at least 24 h from now.
   3. `update-post-tool` on the personal post: `status: "scheduled"`,
      `scheduled_at` = the company time + 3 h.

   Each returns `approval_required` and adds a card to your task. That is the
   expected result, not an error.
8. **Tell the board.** Put a publishing block in the task: blog title and URL,
   why you picked it, both LinkedIn texts, both accounts and times (local and
   UTC), and "Approve all 3 on this task". If you have Slack tools and a board
   channel is set, post the same block there with the task link. If you have no
   Slack bot, create a subtask for your manager titled
   `Slack board note: <blog title>` with the block, so its bot posts it.
   Slack is only a notification. Approval happens only on the task cards.
   Set the task to `in_review` and end the run.
9. **After the decision** (you are woken with the result):
   - Check the result: `gh_get_post` (status `published`) and `get-post-tool`
     for each LinkedIn post (status `scheduled`, time in the future).
   - All three ran: replace `#linkedin-pending` with `#linkedin-shared`, record
     the post ids and times, and mark the task `done`.
   - **Blog rejected:** pull both LinkedIn posts back to `status: "draft"`.
     A post must never point at an unpublished blog. Remove `#linkedin-pending`,
     record the reason, and mark the task `done`. The blog can be picked again
     after it is revised.
   - **A LinkedIn post rejected, blog published:** revise that post as a draft and
     request its go-live again (step 7, that call only). The blog keeps
     `#linkedin-pending` until both posts are scheduled.
   - **The scheduled time has passed** before approval: set a new future time and
     request again. Do not let it publish late.

## Rules

- One blog per run, one company post and one personal post per blog.
- Post only to your company's page and the personal profile named in the task.
- Never call `publish-post-tool` and never send `status: "publishing"`. Every
  go-live goes through scheduling and the board.
