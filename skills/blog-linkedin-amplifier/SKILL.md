---
name: blog-linkedin-amplifier
description: Daily routine — pick one new draft blog on your company's Ghost site, prepare its company-page and personal-profile LinkedIn posts in TryPost, and hand all three go-live actions to the board as one decision. Never repeats a blog. Use to publish or promote the day's blog on LinkedIn.
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

Two facts make a repeat impossible:

- **Only drafts are candidates.** Once a blog is published it can never be picked again.
- **An in-flight draft carries the Ghost internal tag `#linkedin`** (readers
  never see internal tags). You add it while the post is still a draft (step 6)
  and remove it only if the board rejects the blog (step 9).

`gh_update_post` **replaces** the tag list. Always send the existing tags
plus or minus `#linkedin`.

The leading `#` is what makes the tag internal (Ghost slug `hash-linkedin`).
**Never send `linkedin` without the `#`**: that creates a public tag that shows
as a chip on the company website. If a post comes back with a plain `linkedin`
tag, replace it with `#linkedin` in the same call. Do not "fix" `#linkedin`.

## Steps

1. **One at a time.** The routine skips a run while the previous one is still
   open. If the task tells you an earlier blog is still waiting for the board,
   finish that one with step 9 and do not pick a new one.
2. **Find candidates.** `gh_list_posts` with `status: "draft"`, all pages.
   Drop every post tagged `#linkedin`. Also drop posts that are not ready: an
   empty body, a title with "TODO" or "WIP", or anything the task says to skip.
   No candidates: comment "No new blog today", mark the run `done`, and end.
3. **Pick the most exciting one.** Read the candidates (`gh_get_post`). Pick
   on timeliness, a concrete outcome or number, relevance to the company's
   buyers, and a strong hook. Prefer posts created since the last run. In the
   task, give one sentence on why you picked it.
4. **Second guard.** In TryPost, call `list-posts-tool` with `search` = the blog's
   slug and `channels` = [company page id, personal profile id], no status
   filter, all pages. Any hit means it was already shared: tag the blog
   `#linkedin`, say so in the task, and go back to step 3.
5. **Draft both LinkedIn posts** (`create-post-tool`, `status: "draft"`
   explicitly; never `scheduled_at` while drafting):
   - **Company page:** a hook line, a 2–4 sentence summary, and the takeaway.
     Link to `<blog base URL>/<slug>/`, the public URL after publish (not the
     draft preview URL). Add 3–5 relevant hashtags. Stay under the account's
     `max_content_length`.
   - **Personal profile:** different text, first person, a short point of view
     on why it matters, and the same link. Do not paste the company post.
   - Check both with `preview-post-tool`.
6. **Tag the draft.** `gh_update_post` with tags = existing + `#linkedin`.
7. **Request go-live: three calls in this order, each once, no retries:**
   1. `gh_publish_post` with the post id (no `published_at`; it publishes on approval).
   2. `update-post-tool` on the company post: `status: "scheduled"`,
      `scheduled_at` = the next weekday 09:00 in the account timezone,
      at least 24 h from now.
   3. `update-post-tool` on the personal post: `status: "scheduled"`,
      `scheduled_at` = the company time + 3 h.

   Each returns `approval_required` and adds a card to your task. That is the
   expected result, not an error. **Approve all** runs them in this order and
   stops at the first failure.
8. **Tell the board.** Put a publishing block in the task: blog title and URL,
   why you picked it, both LinkedIn texts, both accounts and times (local and
   UTC), and "Approve all 3 on this task". If you have Slack tools and a board
   channel is set, post the same block there with the task link. If you have no
   Slack bot, create a subtask for your manager titled
   `Slack board note: <blog title>` with the block, so its bot posts it.
   Slack is only a notification. Approval happens only on the task cards. Set
   the task to `in_review` and end the run.
9. **After the decision** (you are woken with the result):
   - Check the result: `gh_get_post` (status `published`) and `get-post-tool`
     for each LinkedIn post (status `scheduled`, time in the future).
   - All three ran: record the post ids and times, and mark the task `done`.
   - **Blog rejected or failed:** pull any scheduled LinkedIn post back to
     `status: "draft"`. A post must never point at an unpublished blog. Remove
     `#linkedin` from the still-draft blog so it can be picked again after
     revision. Record the reason and mark the task `done`.
   - **A LinkedIn post rejected, blog published:** revise that post as a draft and
     request its go-live again (step 7, that call only).
   - **The scheduled time has passed** before approval: set a new future time and
     request again. Do not let it publish late.

## Rules

- One blog per run, one company post and one personal post per blog.
- Post only to your company's page and the personal profile named in the task.
- Never call `publish-post-tool` and never send `status: "publishing"`. Every
  go-live goes through scheduling and the board.
