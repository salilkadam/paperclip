---
name: source-back-post
description: "When a blog is live on reliora.ai, draft one genuinely useful reply for a community thread it answers (its own source, or a recent thread it truly answers), for a person to post. Never posts to Reddit, Hacker News or Stack Exchange itself. Use for the source back-post routine."
---

# Live blog → a reply a person posts

One run drafts **at most one** reply. You never post on Reddit, Hacker News or
Stack Exchange: the gateway blocks it, and the owner decided (2026-10-28) that a
person posts every community reply. **The poster is the owner, Salil Kadam, from
his own accounts, for every company** (Reliora Inc and Bionic AI Solutions;
owner, 2026-10-29). You deliver a **ready-to-paste reply** and the thread link;
he posts it.

A reply is only worth writing if the thread's people would thank us for it.
Promotion that is off-topic, repeated or vague gets removed and gets accounts
banned. When in doubt, skip and say why.

## Inputs (from the routine description)

- Ghost `tenant_id` and the public blog base URL (`https://reliora.ai/blog/`).
- Ledger `$AGENT_HOME/life/resources/blog-topics/ledger.md` (written by
  **community-pain-blog**) and reply log `$AGENT_HOME/life/resources/blog-topics/replies.md`.
- Product notes `$AGENT_HOME/life/resources/<product>/` (public, shipped facts only).
- Limits: 1 reply per thread ever; 1 per subreddit (or site) per 7 days; 2 per blog.
  The same person posts for every company, so the per-thread and 7-day limits
  count **his** replies for any company, not only yours (see gate point 6).

## 1. Pick the blog

Live blogs only: `gh_get_post` must say `published`. Never link a draft or a
scheduled post. Oldest live blog first that still has reply budget (fewer than 2
replies in the log).

## 2. Find the thread (two lanes)

- **Source lane:** the blog's ledger line names its source thread. Use it if it
  still exists and is open.
- **Match lane:** search the last 30 days for threads the blog genuinely answers:
  Reddit (`REDDIT_SEARCH_ACROSS_SUBREDDITS`, one tool per call, simple
  `subreddit:<name> <keyword>` queries), Stack Exchange
  (`STACK_EXCHANGE_SEARCH_ADVANCED`), Hacker News (the public Algolia API from your
  own runtime: `curl -s -G https://hn.algolia.com/api/v1/search --data-urlencode query=...`).
  Use the product notes' search keywords and the blog's own headings.

## 3. Relevance gate (all must hold; write each answer in the task)

1. The thread asks a question or describes a problem, and the blog's core content
   answers it. Not merely the same technology: the same failure.
2. Same context: production vs homelab, the same tool (CloudNativePG is not
   Longhorn), a version range the blog covers.
3. Read the post and **every** top-level comment. List what has already been
   said. Your reply must add at least one useful point nobody has made.
4. The thread is open, younger than 90 days, and not a rant or a news post.
5. The community allows it: read the subreddit's or site's rules. If they forbid
   links or vendor replies, skip.
6. Limits: not already replied to; the subreddit/site has had no reply from us
   in 7 days; the blog has fewer than 2 replies. "Us" is the poster, for any
   company: also read the thread's comments and the poster's recent activity
   there with read tools (a comment by him in that thread or subreddit in the
   last 7 days fails this point). If you cannot check his activity, say so in the
   task so he checks before posting.

Any "no": skip the thread, record it in the log with the reason, try the next.
No thread passes: comment "No thread passed the relevance gate" with the
candidates and reasons, and end.

## 4. Draft

- **Lead with the answer**, in the thread's own tone: 2 to 4 concrete steps or
  one clear insight that helps even if nobody clicks. Commands, fields and
  settings must be checked against the official docs; copy nothing unverified.
- **Add what is missing** from the thread (point 3 above), and refer to others'
  points briefly when you build on them ("same family as your … one").
- **Claim only what is true.** If the blog is a proposed design, never write
  "this happened to us" or "we run this". No customers, numbers or quotes the
  product notes do not support as shipped + public. Never name an anonymous
  poster.
- **Disclose once, plainly**, in his voice, naming the company whose blog you
  link, matching the thread's own style if someone already disclosed. Reliora:
  "Full disclosure: I'm with Reliora (we build Srenix, an AI SRE for
  Kubernetes)." Bionic AI Solutions: "Full disclosure: I run Bionic AI
  Solutions" plus what it does, from your product notes. Never both companies in
  one reply.
- **One link, last**, to the live post: "I wrote this up in more detail here, if
  it's useful: https://reliora.ai/blog/<slug>". No hashtags, no sales words, no
  headings.
- 120 to 220 words. Reddit markdown (inline code, short lists); plain text with
  the bare link for Hacker News.

Self-check before handing it over, and fix anything that fails: Would a regular
of this community upvote it without the link? Is every technical claim verified?
Does it repeat something already in the thread? Is the disclosure there? Is the
blog live?

## 5. Hand it to a person

- **First two replies ever:** the CMO reviews them first. Create a subtask
  assigned to your manager (the CMO) with the exact text, thread URL, blog URL
  and your gate answers, mark this task `blocked` by it, and end the run. Continue
  when the subtask is done with an approval; rework the draft if it asks for
  changes.
- Post in the task, under **"Ready to post"**: the site and thread title + URL,
  the exact reply in a code block, the posting note ("For Salil to post from
  his own account. The site's self-promotion rules and the community's vendor
  rules bind that account. Edit it into your own voice, and never post it as a
  first-person experience you did not have"), and your relevance-gate answers.
- **Always post the request in the company's board Slack channel** (owner's
  practice, 2026-10-29): Salil takes it up from Slack, so the message must be
  complete on its own. Send it the way **board-approval-notify** sends board
  notes (its channel table; your Slack tools, or the "Board note" subtask for the
  CMO when you have none), written by **board-plain-language**:

  ```
  Reply ready for you to post: <site> - "<thread title>"
  Thread: <thread URL>
  Why it fits: <one sentence: the problem they have that the blog answers>
  Links to: "<blog title>" - <public blog URL>
  Reply (copy, then edit into your own voice):
  <the full reply text, exactly as in the task>
  Before posting: <only if needed, e.g. "I could not check your comments in
  r/<name> this week; skip if you posted there in the last 7 days">
  When posted, put the comment link on the task: <task link>
  ```

  Send it only once the reply is ready for him (after the CMO's review for the
  first two). One message per reply; never a Slack note for a skipped thread.
  A failed Slack post: say so in the task, verbatim, and leave it `in_review`.
  Set the task `in_review`.
- A thread whose source is an article or postmortem by a named author: say so in
  the task. Contacting the author is the board's decision; never email or
  message them yourself from this routine.

## 6. Record and follow up

- Log line in `replies.md`: `YYYY-MM-DD | blog slug | site | thread URL | lane |
  status (ready|posted|skipped:<reason>) | reply first line`.
- When Salil puts the comment link on the task, mark it `posted`. Slack replies
  are not a record: only the task counts.
- **Feedback:** on later runs, check each posted reply at about 24 hours and 7
  days (score, replies, removed?) with read tools, and record it.
- **Stop rule:** a removed reply, or two replies at a score below 1 in the same
  subreddit/site, stops replies there. Record it and tell the board; only the
  board lifts it.
- Weekly (first run of the week): a short summary in the task: replies drafted,
  posted, skipped (top reasons), and the feedback.
