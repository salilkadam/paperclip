---
name: x-post-writer
description: "Draft a single tweet or short thread for X (Twitter) with a 2026 hook formula picked by goal (replies, reposts, likes, bookmarks). Fits 280 chars (25,000 on Premium), runs the humanizer, publishes via TryPost after board approval. Not for long threads (x-thread-builder)."
key: paperclipai/optional/x/x-post-writer
recommendedForRoles:
  - content-marketer
  - marketer
  - social-media-manager
  - writer
  - founder
tags:
  - x
  - social-media
  - copywriting
  - tweets
---

# X Post Writer

> Read `social-core`, then the `x-marketing` hub, before using this skill. Tools, publishing and approval follow `social-core`. If either skill is not installed, stop and ask the board to install the Social Content Studio team or both skills.

Ship a single tweet, or a tight 2-3 tweet micro-thread, using hook shapes that
actually travel on X in 2026. Single-tweet formulas land a complete punch in
the first line, because X has no "see more" fold.

## When to use

- User says "write me a tweet about X"
- User has a topic or a rough one-liner and wants a sharper hook
- User wants to pick a proven single-tweet shape and fill in their voice
- User wants a quick draft that goes to TryPost for board approval

## Formulas this skill uses (single-tweet shapes)

| Code | Formula | Primary goal | Best for |
|---|---|---|---|
| X1 | One-Liner Contrarian | reposts | a sharp, defensible against-the-grain take |
| X2 | Data-Point Hook | bookmarks | one odd-precision number that reframes a thing |
| X3 | Build-in-Public Confession | replies | a real metric from your own work, ugly ones included |
| X4 | Quote-Tweet Dunk-with-Value | reposts | adding a layer to someone else's take (quote tweet) |
| X5 | Mini-List Tweet | bookmarks | a scannable list that fits in one tweet |
| X6 | Relatable Cold-Open | likes | a specific shared moment, no setup |
| X11 | Third-Person Case-Study Flex | reposts | someone else's absurd, specific result as anyone-could-copy bait |

Full skeletons in the `x-marketing` skill's `references/hook-formulas.md`. For long-form tweetstorms
(X7-X10), use `x-thread-builder`. X11 was validated as the top-recurring winning
shape in a ~450-tweet corpus (July 2026); prefer it over a first-person "How I"
when the result you are citing is someone else's.

### Pick by goal first

| Goal | Reach for |
|---|---|
| Replies | X3, X1 |
| Reposts | X1, X4, X11 |
| Likes | X6 |
| Bookmarks | X2, X5, X11 |

## Steps

**Voice profile first (all drafts).** If the voice profile in memory (`$AGENT_HOME/life/resources/social/voice-profile.md`, plus `x/voice-profile.md` overrides; template: the `x-marketing` skill's `references/voice-profile.md`) has `filled: yes`, load it and match the user's voice fingerprint, hard rules, and CTA/link style throughout. If it is not filled, mention once that `x-humanizer --mode profile` can learn their voice from a few posts, then proceed with the generic voice rules.

**Story bank next.** If the story bank in memory (`$AGENT_HOME/life/resources/social/story-bank.md`; template: the `x-marketing` skill's `references/story-bank.md`) has `filled: yes`, load it and take every concrete detail (numbers, dates, named projects, positions) from there instead of asking mid-draft. **Never invent a figure, a date or a client name that is not in the bank or supplied in the task.** If the bank has nothing that fits, ask in the task, or say once that `x-humanizer --mode interview` fills it in 20 to 40 minutes. A draft with a plausible invented number is worse than a draft with none: one is vague, the other is a retraction.

1. **Gather inputs.** Topic, angle, any rough draft, target audience (builders /
   founders / a niche), and the goal (replies / reposts / likes / bookmarks).
2. **Pick the container.** If the idea is one claim, one number, or one moment,
   it is a single tweet. If it is a scannable one-line-per-item list, still a
   single tweet (X5). If items need teaching or the idea has a build, hand off
   to `x-thread-builder`.
3. **Pick the formula.** Use the goal table to shortlist, then suggest 2-3 that
   also fit the topic and let the user choose.
4. **Draft the tweet.** Fill the skeleton in the user's voice. Respect the 2026
   X rules:
   - First line carries the whole load (no fold).
   - Under 280 chars on a standard account (emoji count as 2 chars). Confirm the
     account's tier (`max_content_length` in `list-social-accounts-tool`: 280, or
     25,000 with long posts); only go long if it is Premium and the length earns it.
   - One idea per tweet. Line breaks as beats.
   - 0-1 hashtag at the end, 0-1 emoji, none on a serious take.
   - No external link in the tweet (offer to put it in a reply).
5. **Humanizer pass.** Scrub 2026 AI vocab by density, cap em dashes (at
   most one per tweet, never swap one for a period), break stacked triads,
   generic openers and reveal bridges. Leave a single tweet's rhythm alone
   (uniform rhythm wins on short posts; never insert a fragment for punch).
   Add an odd-precision number with a named referent or a named entity where
   the claim allows it. Canonical rules: `x-humanizer` V3.
6. **Optional audit.** Invoke `x-humanizer --mode audit` for a pass-fail check.
7. **Draft summary.** Put in the task: formula used, full draft, char count
   (note if emoji push it over 280), suggested posting window, primary goal.
8. **Publish through TryPost** (`social-core` section 2). Create the post on the
   company's X account with `create-post-tool` and `status: "draft"`;
   `preview-post-tool`; put the publishing block in the task; request go-live
   once with `update-post-tool` (`status: "scheduled"` plus `scheduled_at`, or
   `status: "publishing"`) and stop at the approval card. TryPost does not split
   long text: for a 2-3 tweet micro-thread, tweet 1 is `content` and the rest go
   in `meta.thread_replies` (see the `x-marketing` hub, "Publishing on X through
   TryPost").

## Hard rules

Global voice rules: the `x-marketing` hub's Voice rules. Additional skill-specific
rules:

- The first line must stop the scroll on its own. Rewrite any opener that needs
  line 2 to make sense.
- Keep a standard-account tweet inside 280 chars. If it does not fit, tighten it
  or escalate to a thread, never ship a truncated thought.
- One specific number where the claim allows it. 2.4x beats "way better".
- Do not hard-sell the user's product. One natural mention max.

## Anti-patterns (skill will refuse)

- ALL CAPS first line for intensity. Carry intensity with word choice.
- Em dashes above the cap (more than one in a tweet), or an em dash swapped for a period.
- "Here's what / here's how" or "Stop X, start Y" as the opener; "The result?" as a reveal.
- Announced candor ("Let me be honest", "not gonna lie") with no dated fact behind it.
- "Unpopular opinion:" on a take that is actually popular.
- Padding a one-line idea with filler to look substantial.
- Rule-of-three lists without specifics.
- "leverage", "fundamentally", "game-changer", "deep dive".
- External link in the tweet body.
- Engagement bait ("RT if you agree", "reply YES").

## Resources

- the `x-marketing` skill's `references/hook-formulas.md` - all 11 X formula skeletons (X1-X6 and X11 are single-tweet)
- the `x-marketing` skill's `references/algorithm-heuristics.md` - 2026 X ranking rules (signals, timing, limits)
- `references/single-tweet-checklist.md` - the per-tweet scrub and fit list

## Optional illustration

Offer a generated image when a visual would lift reach. Draft a prompt and call
Loc-GenImage `gi_generate_image` (wide, 16:9), pulling brand handle/color from Voice &
Brand Profile section 6; use `gi_text_edit_image` when the image must carry
legible text. Show the returned public URL in the task, then attach it to the
TryPost draft as `media: [{ "url": "<url>" }]`. Full workflow (incl. quote-cards):
the `x-humanizer` skill's `sub-skills/illustration.md`. No Loc-GenImage connection -> draft the prompt in the task for a human to generate.

## Related skills

- `x-thread-builder` - when the idea needs more than a tweet
- `x-humanizer` - aggressive AI-tell scrubber, plus `--mode audit` for review
- `x-hook-extractor` - reverse-engineer a hook from a tweet you admire
