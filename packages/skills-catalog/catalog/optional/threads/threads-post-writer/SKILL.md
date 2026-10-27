---
name: threads-post-writer
description: "Draft a single Threads (Meta) post or multi-post thread with a 2026 Threads hook formula picked by goal (replies, reposts, likes, quotes). Fits 500 chars and the one-hashtag cap, runs the humanizer, publishes via TryPost after board approval (thread follow-ups are copy-paste)."
key: paperclipai/optional/threads/threads-post-writer
recommendedForRoles:
  - content-marketer
  - marketer
  - social-media-manager
  - writer
  - founder
tags:
  - threads
  - social-media
  - copywriting
  - posts
---

# Threads Post Writer

> Read `social-core`, then the `threads-marketing` hub, before using this skill. Tools, publishing and approval follow `social-core`. If either skill is not installed, stop and ask the board to install the Social Content Studio team or both skills.

Ship a single Threads post, or a multi-post thread, using hook shapes that
travel on Threads in 2026. Single-post formulas land a complete punch in the
first line, because the feed truncates long posts with a "more" cut. Threads
posts run warmer and more conversational than X.

## When to use

- User says "write me a Threads post about X"
- User has a topic or a rough one-liner and wants a sharper hook
- User wants to turn notes into a multi-post thread
- User wants a quick draft that goes to TryPost for board approval

## Formulas this skill uses

Single-post shapes (T1-T6):

| Code | Formula | Primary goal | Best for |
|---|---|---|---|
| T1 | Warm Contrarian | reposts | a sharp, defensible take framed as an invite |
| T2 | Data-Point Hook | reposts | one odd-precision number that reframes a thing |
| T3 | Build-in-Public Confession | replies | a real metric from your own work, ugly ones included |
| T4 | Quote-Post Add-Value | quotes | adding a layer to someone else's take (quote post) |
| T5 | Mini-List Post | reposts | a scannable list that fits in one post |
| T6 | Relatable Cold-Open | likes | a specific shared moment, no setup |
| T11 | First-Person Status Flex | replies | a flat status or milestone, then a counterintuitive pivot |
| T12 | Permission Reframe | quotes | "Most {group} DON'T NEED {thing}, they need {permission}" |
| T13 | Copy-Swap Micro-Lesson | reposts | one before/after swap: weak version, then strong version |

Thread shapes (T7-T10):

| Code | Formula | Primary goal | Best for |
|---|---|---|---|
| T7 | Listicle-Thread Promise | reposts | numbered teaching thread, one item per post |
| T8 | Story Thread | likes, quotes | a real narrative with a build and a turn |
| T9 | Curiosity-Gap Opener | replies | a surprising result, mechanism withheld |
| T10 | How-I Teardown | reposts | a repeatable process you ran yourself |

Full skeletons in the `threads-marketing` skill's `references/hook-formulas.md`. T11-T13 were added from a
318-post corpus pull (July 2026): the status flex, permission reframe, and copy
swap topped the aspirational-warm Threads feed. They are strong hypotheses to
test, anchored on small-account examples, not yet follower-normalized.

### Pick by goal first

| Goal | Reach for |
|---|---|
| Replies | T3, T9, T1, T11 |
| Reposts | T2, T5, T7, T10, T13 |
| Likes | T6, T8 |
| Quotes | T4, T8, T12 |

## Pick the container first

| If the idea is... | Container | Formulas |
|---|---|---|
| One claim, one number, one moment | single post | T1, T2, T3, T6, T11, T12 |
| A scannable list, one line per item | single post | T5 |
| One before/after copy swap | single post | T13 |
| A list where each item needs teaching | thread | T7 |
| A narrative with a build and a turn | thread | T8 |
| A surprising result with a mechanism | thread | T9 |
| A repeatable process you ran yourself | thread | T10 |

A thread on a one-line idea reads as padding. A single post trying to teach five
things should be a thread.

## How a thread goes into TryPost

TryPost does not split text, so split the thread yourself:

- at paragraph breaks (`\n\n`) first,
- then at sentence endings,
- then at word boundaries as a fallback.

Unlike X, Threads does NOT add `(1/N)` markers by default. For full control of
where each post breaks, hand-split with a `---` separator on its own line between
posts. The skill defaults to hand-splitting with `---` so the board sees exactly
how the thread will land before approving.

Check `list-content-types-tool` at run time. TryPost chains a thread through
`meta.thread_replies` only where the content type reports
`supports_thread_replies: true`; at the time of writing Threads does **not**
(X, Bluesky and Mastodon do). So, unless the tool now says otherwise:

- Post 1 goes through TryPost as a normal draft and approval.
- Posts 2..N go in the task as a numbered copy-paste block, for a human to add
  as replies under post 1 once it is live. Say so in the publishing block.
- Do not invent another chaining mechanism.

If it does report `supports_thread_replies: true`, post 1 is `content` and posts
2..N are `meta.thread_replies` entries, within `max_thread_replies`.

> If multi-post nesting is temporarily paused (Meta app reconnection), fall back
> to posting the opener as a single post and adding the rest as replies by hand.
> See the `threads-marketing` skill's `references/algorithm-heuristics.md`.

## Steps

**Voice profile first (all drafts).** If the voice profile in memory (`$AGENT_HOME/life/resources/social/voice-profile.md`, plus `threads/voice-profile.md` overrides; template: the `threads-marketing` skill's `references/voice-profile.md`) has `filled: yes`, load it and match the user's voice fingerprint, hard rules, and CTA/link style throughout. If it is not filled, mention once that `threads-humanizer --mode profile` can learn their voice from a few posts, then proceed with the generic voice rules.

**Story bank next.** If the story bank in memory (`$AGENT_HOME/life/resources/social/story-bank.md`; template: the `threads-marketing` skill's `references/story-bank.md`) has `filled: yes`, load it and take every concrete detail (numbers, dates, named projects, positions) from there instead of asking mid-draft. **Never invent a figure, a date or a client name that is not in the bank or supplied in the task.** If the bank has nothing that fits, ask in the task, or say once that `threads-humanizer --mode interview` fills it in 20 to 40 minutes. A draft with a plausible invented number is worse than a draft with none: one is vague, the other is a retraction.

1. **Gather inputs.** Topic, angle, any rough draft, target audience (builders /
   founders / a niche), and the goal (replies / reposts / likes / quotes).
2. **Pick the container.** Use the container table. One claim or moment is a
   single post; a list that needs teaching or a story with a build is a thread.
3. **Pick the formula.** Use the goal table to shortlist, then suggest 2-3 that
   also fit the topic and let the user choose.
4. **Draft.** Fill the skeleton in the user's voice. Respect the 2026 Threads
   rules:
   - First line carries the whole load (the feed truncates with "more").
   - Under 500 chars per post (10,000 only if a text attachment is in play;
     TryPost does not expose one, so check the account's `max_content_length`
     in `list-social-accounts-tool`).
   - One idea per post. Line breaks as beats.
   - 0-1 hashtag at the end (Threads allows only one), 0-2 emoji, none on a
     serious take.
   - No external link in post 1 (offer to put it in a reply).
   - Warm and conversational, not a transplanted X dunk.
5. **For a thread:** write post 1 first (the promise + open loop), front-load the
   strongest beat at position 1-2, target 4-7 posts for teaching/list threads,
   make each post stand alone, and close on the most quotable line plus one ask.
6. **Humanizer pass.** Scrub 2026 AI vocab by density, cap em dashes (at
   most one per post, never swap one for a period), break stacked triads,
   generic openers and reveal bridges. Leave the rhythm alone: uniform rhythm
   wins on Threads at every length, so never insert a punch post or chop a
   sentence for variance. Add an odd-precision number with a named referent
   or a named entity where the claim allows it. Canonical rules:
   `threads-humanizer` V3.
7. **Optional audit.** Invoke `threads-humanizer --mode audit` for a pass-fail
   check.
8. **Draft summary.** Put in the task: formula used, full draft (thread shown
   post-by-post with per-post char counts and total post count), suggested
   posting window, primary goal. Confirm any `---` breaks.
9. **Publish through TryPost** (`social-core` section 2). Create post 1 (or the
   single post) on the company's Threads account with `create-post-tool` and
   `status: "draft"` (one hashtag inline, or `meta.topic_tag`); `preview-post-tool`;
   put the publishing block in the task, with any posts 2..N as the copy-paste
   block described in "How a thread goes into TryPost"; request go-live once
   with `update-post-tool` (`status: "scheduled"` plus `scheduled_at`, or
   `status: "publishing"`) and stop at the approval card. TryPost has no
   reply-control setting for Threads; if the task needs one, a human sets it in
   the app.

## Hard rules

Global voice rules: the `threads-marketing` hub's Voice rules. Additional skill-specific
rules:

- The first line must stop the scroll on its own. Rewrite any opener that needs
  line 2 to make sense.
- Keep each post inside 500 chars. If it does not fit, tighten it or escalate to
  a thread, never ship a truncated thought.
- One hashtag maximum. A second is rejected by Threads, not just bad style.
- One specific number where the claim allows it. 2.4x beats "way better".
- Do not hard-sell the user's product. One natural mention max.
- For a thread, post 1 must contain a real promise and an open loop. A bare
  "a thread:" label is not a hook.

## Anti-patterns (skill will refuse)

- ALL CAPS first line for intensity. Carry intensity with word choice.
- Em dashes above the cap (more than one in a post), or an em dash swapped for a period.
- "Here's what / here's how" or "Stop X, start Y" as the opener; "The result?" as a reveal.
- Announced candor ("Let me be honest", "not gonna lie") with no dated fact behind it.
- "Unpopular opinion:" on a take that is actually popular.
- Padding a one-line idea into a thread.
- Rule-of-three lists without specifics.
- "leverage", "fundamentally", "game-changer", "deep dive".
- External link in post 1.
- A second hashtag.
- Engagement bait ("repost if you agree", "reply YES").
- A thread of identical-length posts (machine rhythm).
- Importing a cold, combative X voice.

## Resources

- the `threads-marketing` skill's `references/hook-formulas.md` - all 13 Threads formula skeletons (T1-T6 and T11-T13 single, T7-T10 thread)
- the `threads-marketing` skill's `references/algorithm-heuristics.md` - 2026 Threads ranking rules (signals, timing, limits)
- `references/single-post-checklist.md` - the per-post scrub and fit list
- `references/thread-structure.md` - per-position pacing and the closer playbook

## Optional illustration

Offer a generated image when a visual would lift reach. Draft a prompt and call
Loc-GenImage `gi_generate_image` (square, 1:1), pulling brand handle/color from Voice &
Brand Profile section 6; use `gi_text_edit_image` when the image must carry
legible text. Show the returned public URL in the task, then attach it to the
TryPost draft as `media: [{ "url": "<url>" }]`. Full workflow (incl. quote-cards):
the `threads-humanizer` skill's `sub-skills/illustration.md`. No Loc-GenImage connection -> draft the prompt in the task for a human to generate.

## Related skills

- `threads-humanizer` - aggressive AI-tell scrubber, plus `--mode audit` for review
- `threads-hook-extractor` - reverse-engineer a hook from a post you admire
- `threads-content-planner` - schedule posts and threads into a weekly cadence
