---
name: x-thread-builder
description: "Build a long-form X (Twitter) thread with a 2026 thread formula (listicle, story, curiosity gap, how-I teardown) picked by goal. Tweet 1 promises and opens a loop, one beat per tweet, closes for the repost. Publishes via TryPost meta.thread_replies after board approval."
key: paperclipai/optional/x/x-thread-builder
recommendedForRoles:
  - content-marketer
  - marketer
  - social-media-manager
  - writer
  - founder
tags:
  - x
  - social-media
  - threads
  - copywriting
---

# X Thread Builder

> Read `social-core`, then the `x-marketing` hub, before using this skill. Tools, publishing and approval follow `social-core`. If either skill is not installed, stop and ask the board to install the Social Content Studio team or both skills.

Build tweetstorms that get read all the way down. On X, tweet 1 is the entire
funnel: it has to promise a payoff and open a loop, or no one taps "Show this
thread." Everything after only matters if tweet 1 earns the tap.

## When to use

- User says "turn this into a thread" or "write me a thread about X"
- The idea is a list where each item needs teaching, a story with a build, a
  surprising result with a mechanism, or a repeatable process
- User has a single tweet that is trying to do too much and should be a thread

## Formulas this skill uses (thread shapes)

| Code | Formula | Primary goal | Best for |
|---|---|---|---|
| X7 | Listicle-Thread Promise | bookmarks | numbered teaching thread, one item per tweet |
| X8 | Story Thread | likes, reposts | a real narrative with a build and a turn |
| X9 | Curiosity-Gap Opener | replies, bookmarks | a surprising result, mechanism withheld |
| X10 | How-I Teardown | bookmarks | a repeatable process you ran yourself |

Full skeletons in the `x-marketing` skill's `references/hook-formulas.md`. For single tweets
(X1-X6), use `x-post-writer`.

### Pick by goal first

| Goal | Reach for |
|---|---|
| Bookmarks | X7, X10, X9 |
| Likes | X8 |
| Reposts | X8 |
| Replies | X9 |

## How a thread goes into TryPost

TryPost publishes a thread on X as **one post**: tweet 1 is `content`, and every
later tweet is one entry in `meta.thread_replies` (`{ "text": "...", "media":
[...] }`, or a plain string for a text-only reply). Check
`list-content-types-tool` at run time: X's content type must report
`supports_thread_replies: true`, and `max_thread_replies` caps the chain (24
replies, so 25 tweets, when this was written). Every reply must fit the
account's `max_content_length` and follows X's media rules (up to 4 per tweet).

TryPost does not split or number the thread for you, so split it yourself the
way an auto-splitter would:

- at paragraph breaks (`\n\n`) first,
- then at sentence endings,
- then at word boundaries as a fallback,
- and add `(1/N)` markers if the format calls for them, reserving ~8 chars per
  tweet for the marker.

Draft with a `---` separator on its own line between tweets, so the board sees
exactly how the thread will land before approving; each `---` block becomes one
tweet (the first in `content`, the rest in `meta.thread_replies`, in order).

## Steps

**Voice profile first (all drafts).** If the voice profile in memory (`$AGENT_HOME/life/resources/social/voice-profile.md`, plus `x/voice-profile.md` overrides; template: the `x-marketing` skill's `references/voice-profile.md`) has `filled: yes`, load it and match the user's voice fingerprint, hard rules, and CTA/link style throughout. If it is not filled, mention once that `x-humanizer --mode profile` can learn their voice from a few posts, then proceed with the generic voice rules.

**Story bank next.** If the story bank in memory (`$AGENT_HOME/life/resources/social/story-bank.md`; template: the `x-marketing` skill's `references/story-bank.md`) has `filled: yes`, load it and take every concrete detail (numbers, dates, named projects, positions) from there instead of asking mid-draft. **Never invent a figure, a date or a client name that is not in the bank or supplied in the task.** If the bank has nothing that fits, ask in the task, or say once that `x-humanizer --mode interview` fills it in 20 to 40 minutes. A draft with a plausible invented number is worse than a draft with none: one is vague, the other is a retraction.

1. **Gather inputs.** Topic, the raw material (notes, a transcript, a result),
   target audience, and the goal (bookmarks / likes / reposts / replies).
2. **Pick the formula** from the goal table, confirm it fits the material.
3. **Write tweet 1.** This is 80% of the work:
   - Promise a specific payoff (a number, a named result, a clear list count).
   - Open a loop the reader has to resolve ("most people get 3 of them wrong",
     "I did not expect why").
   - Keep it under 280 chars on a standard account. It must stop the scroll
     alone.
4. **Pace the body.** One beat or one item per tweet. Front-load the strongest
   item or beat at position 1-2; tap-through decays with depth. Target 5-9
   tweets for teaching/list threads; longer only for a strong story.
5. **Make each tweet stand alone.** A reader landing mid-thread from a quote
   tweet should still get something.
6. **Write the closer.** The last tweet earns the repost and the follow. End on
   the most quotable line, then one clear ask (bookmark, follow, or "reply with
   yours"), not both.
7. **Humanizer pass** on every tweet. Scrub 2026 AI vocab by density, cap em
   dashes (at most one per tweet, never swap one for a period), break stacked
   triads and reveal bridges. Let tweet length vary only as the material
   varies: never insert a 3-word punch tweet for rhythm, never alternate
   long/short, and touch rhythm only if the whole thread reads machine-flat.
   Canonical rules: `x-humanizer` V3.
8. **Optional audit.** Run `x-humanizer --mode audit` on the assembled thread.
9. **Draft summary.** Put in the task the thread tweet-by-tweet with per-tweet
   char counts, total tweet count, the formula, and the goal. Confirm any `---`
   breaks.
10. **Publish through TryPost** (`social-core` section 2). Create one post on the
    company's X account with `create-post-tool`, `status: "draft"`, tweet 1 as
    `content` and tweets 2..N as `meta.thread_replies`; `preview-post-tool`;
    put the publishing block (with every tweet) in the task; request go-live
    once with `update-post-tool` (`status: "scheduled"` plus `scheduled_at`, or
    `status: "publishing"`) and stop at the approval card. After the approved
    call runs, check with `get-post-tool` which tweets went live and record it.

## Hard rules

Global voice rules: the `x-marketing` hub's Voice rules. Additional skill-specific
rules:

- Tweet 1 must contain a real promise and an open loop. A bare "A thread:" label
  is not a hook.
- Keep each tweet under 280 chars on a standard account (emoji = 2 chars).
- Front-load value. Never bury the best item at the end of a teaching thread.
- No external link in tweet 1. Put links in a later tweet or a reply.
- Natural rhythm, not manufactured variance. A long thread where every tweet
  is the same length and none carries a real clause reads machine-flat; fix
  that one thing. Never pad or chop tweets to create variance, and never
  insert a punch tweet: the inserted punch is the humanizer fingerprint.
- Only ship a Story Thread (X8) built on a true story. Readers punish
  manufactured stakes.

## Anti-patterns (skill will refuse)

- Tweet 1 that closes its own loop (no reason to expand).
- Over-promising in tweet 1 and under-delivering in the body.
- Vague how-to steps ("be consistent", "add value") in an X10 teardown.
- Padding to hit a round number of tweets.
- Em dashes above the cap (more than one in a tweet), AI vocab clusters, ALL CAPS openers.
- "The result?" reveals, "No X. No Y. Just Z." staccato stacks, one-word tweets for drama.
- Announced candor ("Let me be honest", "not gonna lie") with no dated fact behind it.
- Engagement-bait closers ("RT if this helped").

## Resources

- the `x-marketing` skill's `references/hook-formulas.md` - X7-X10 thread skeletons with worked shapes
- the `x-marketing` skill's `references/algorithm-heuristics.md` - thread length, tap-through decay, signals
- `references/thread-structure.md` - per-position pacing and the closer playbook

## Related skills

- `x-post-writer` - when the idea is really just one tweet
- `x-humanizer` - scrub each tweet, or `--mode audit` the whole thread
- `x-hook-extractor` - lift the structure from a viral thread you admire
- `x-content-planner` - schedule threads into a weekly cadence
