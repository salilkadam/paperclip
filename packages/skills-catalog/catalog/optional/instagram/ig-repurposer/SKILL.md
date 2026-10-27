---
name: ig-repurposer
description: "Repurpose a LinkedIn post, blog article (Ghost), YouTube script or X thread into a native Instagram carousel or caption, re-hooked before the 125-char fold with off-platform artifacts stripped, then a TryPost draft. Not for writing from scratch or auditing a draft."
key: paperclipai/optional/instagram/ig-repurposer
recommendedForRoles:
  - content-marketer
  - marketer
  - social-media-manager
  - writer
tags:
  - instagram
  - social-media
  - repurposing
  - cross-platform
---

# Instagram Repurposer

> Read `social-core`, then the `instagram-marketing` hub, before using this skill. Tools, publishing and approval follow `social-core`. If either skill is not installed, stop and ask the board to install the Social Content Studio team or both skills.

Turn something you already made into a post that reads like it was born on
Instagram. Repurposing is not copy-paste. A post that killed on LinkedIn or a
thread that flew on X will die on Instagram if you paste it: wrong hook, wrong
container, wrong rhythm, no media, and artifacts ("link in bio", @-handles,
hashtag walls) that scream off-platform.

This skill transforms, it does not generate. It reads your source, keeps the
idea, and rebuilds the delivery for Instagram.

## When to use

- "Turn this LinkedIn post into an Instagram carousel / caption"
- "Repurpose my blog post / newsletter / YouTube script for Instagram"
- "This thread worked on X, adapt it for Instagram"
- "I have a rough idea in another format, make it native here"

Not for a blank-page draft (use `ig-caption-writer` for a single caption,
`ig-carousel-planner` for a slide-by-slide carousel) and not for reviewing an
already-Instagram draft (use `ig-humanizer --mode audit`).

## How it works

**Voice profile first (all drafts).** If the voice profile in memory (`$AGENT_HOME/life/resources/social/voice-profile.md`, with overrides from `$AGENT_HOME/life/resources/social/instagram/voice-profile.md`) has `filled: yes`, load it and match the user's voice fingerprint, hard rules, and CTA/link style throughout. If it is not filled, mention once that `ig-humanizer --mode profile` can learn their voice from a few posts, then proceed with the generic voice rules.

**Never invent the specifics.** The rules below ask for a concrete number, a date and a named entity, because that is what separates a real post from a generated one. Take them from what the user actually said in this conversation. **Do not invent a figure, a date, a client name or a result, and do not soften a vague claim into a plausible-looking number.** If the user has nothing concrete for a beat, ask them once, and if they still have nothing, drop the claim rather than decorate it. A published invented number is a retraction; a missing one is only a weaker post.

1. **Take the source.** Any format: a post, a paragraph, a script, a caption, a
   transcript, a bullet list, a link to read. A company blog post can be fetched
   with the Ghost blog `gh_*` tools. Ask for the source, the media available
   (Instagram needs an image or video; it can be produced in-house), and the goal (saves / shares /
   comments / follows) if not given.
2. **Extract the spine.** Strip the source platform's shell and pull out the one
   claim, the one story, or the one number worth keeping. Most repurposing fails
   because it keeps the words instead of the point.
3. **Choose the container.** One claim or number -> single caption. A teach, a
   list, or a build -> carousel, one point per slide (hand structure to
   `ig-carousel-planner`, hook slide to payoff slide). A long video -> a carousel
   that delivers the payoff, not a summary.
4. **Re-hook for the fold.** Instagram hides everything after ~125 characters
   behind "more". Line one (or the hook slide) must land the whole punch on its
   own. The source's hook almost never survives; write a new first line using a
   2026 Instagram formula (see the `instagram-marketing` skill's `references/hook-formulas.md`), picked by the
   goal.
5. **Refit the format.** Caption body skimmable, short lines, white space between
   beats. Carousel: one idea per slide, no wall. Cut the source's connective
   tissue; Instagram rewards the front-loaded payoff.
6. **Strip off-platform artifacts.** Remove "link in bio" carried from another
   platform, "smash subscribe", "read more below", X @-handles that only exist
   there, and any "as I wrote on LinkedIn" throat-clearing. A repurposed post
   should not admit it was repurposed.
7. **Media reminder.** Instagram rejects text-only posts. Confirm the image,
   video, or slide set the user will attach. A caption with no media is not
   publishable.
8. **Hashtags at the end.** Hand the topic to `ig-hashtag-strategist` or apply a
   3-5 sized set yourself (see the `instagram-marketing` skill's `references/hashtag-strategy.md`). Place them
   as one block at the END of the caption or in the first comment, never as a
   mid-text wall.
9. **Humanizer pass.** Run `ig-humanizer` V3 on the result: 2026 AI vocab by
   paragraph density, em dashes above the cap (about one per 100 words, never
   swapped for a period), stacked rule-of-three triads, generic openers and
   reveal bridges. Fix only a paragraph that reads machine-flat; never
   manufacture variance. Keep the user's real numbers and named entities from
   the source.
10. **Approval card.** Show in the task: source -> Instagram mapping (what became what), the
    container (single caption or N-slide carousel), formula used, the hook (flag
    if over 125 chars), hashtag set, the media the post needs, primary goal.
11. **Publish with media, through the board.** Follow the
    TryPost flow in the `instagram-marketing` skill's `references/media-workflow.md`
    and `social-core` section 2: produce or collect the media (Loc-GenImage for
    an image, `marketing-video-studio` / `motion-explainer-studio` plus Loc-FFmpeg
    for a Reel; carousel slides as in `ig-carousel-planner`), `create-post-tool` on the company's Instagram Business/Creator
    account with `status: "draft"`, the approved caption and `media: [{ id }]` or
    `[{ url }]` (Reel: the Reel content type from `list-content-types-tool`),
    `preview-post-tool`, the publishing block in the task, then one go-live
    request with `update-post-tool` that raises the approval card. With no media
    or no TryPost Instagram account, deliver a copy-paste block and name the
    media still needed.

## Native-fit rules (source -> Instagram)

- **LinkedIn post -> Instagram:** a long post becomes a carousel (one point per
  slide) or, if it is one sharp claim, a single caption. LinkedIn tolerates
  warm-up; Instagram does not. The LinkedIn hook is usually too long; rewrite it
  for the 125-char fold.
- **Blog / newsletter -> carousel:** turn the structure into slides, one point
  per slide, hook slide first, payoff slide last. Do not paste the whole piece
  into one caption.
- **YouTube script -> carousel of the payoff:** lead with the video's payoff, not
  its intro. Build the carousel around "here's what I found", not a scene-by-scene
  recap.
- **Tweet / thread -> caption or carousel:** a single tweet becomes a caption; a
  thread becomes a carousel, one tweet per slide with its own micro-point. Strip
  X @-handles and thread numbering.

## Hard rules

Global voice rules: see the `instagram-marketing` hub's Voice rules. Additional skill-specific
rules:

- Keep the source's **claim and facts** intact. Repurposing changes the delivery,
  never the meaning or the numbers.
- The new first line (or hook slide) must stop the scroll on its own before the
  125-char fold. If it needs the second line, rewrite it.
- Never paste the source verbatim and trim. Rebuild the hook and rhythm from the
  spine.
- One specific number where the source offers one. Keep it.
- 3-5 sized hashtags as one block at the end, never 30 and never mid-caption.
- Media is required. Never present a repurposed caption as publishable without
  reminding the user to attach the image, video, or slides.
- Do not hard-sell the user's product. One natural mention max.

## Anti-patterns (skill will refuse)

- Copy-pasting the source with light edits (that is not repurposing).
- Keeping the source platform's artifacts ("link in bio", "smash subscribe", X
  @-handles, thread numbering).
- A hook that only makes sense after the 125-char fold.
- A mid-caption hashtag wall instead of one block at the end.
- Presenting a caption with no media as ready to post.
- ALL CAPS first line for intensity. Carry it with word choice.
- Em dashes above the cap (more than about one per 100 words), or an em dash swapped for a period.
- "The result?" / "Here's the thing.." reveal bridges and staccato stacks added during the rewrite.
- Rule-of-three lists without specifics.
- "leverage", "fundamentally", "game-changer", "level up", "dive in".
- Meta throat-clearing ("I originally posted this on...").

## Resources

- the `instagram-marketing` skill's `references/hook-formulas.md` - the 10 Instagram formula skeletons to re-hook with
- the `instagram-marketing` skill's `references/algorithm-heuristics.md` - 2026 Instagram ranking rules (fold, timing, signals)
- the `instagram-marketing` skill's `references/hashtag-strategy.md` - the 3-5 sized hashtag recipe
- the `instagram-marketing` skill's `references/media-workflow.md` - the draft, upload, schedule flow

## Related skills

- `ig-caption-writer` - write a fresh single caption from scratch
- `ig-carousel-planner` - structure a slide-by-slide carousel (repurposer hands long builds here)
- `ig-hashtag-strategist` - build the sized hashtag set
- `ig-humanizer` - scrub AI tells, plus `--mode audit` to review the result
