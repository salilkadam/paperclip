---
name: x-repurposer
description: "Repurpose a LinkedIn post, blog (fetched from Ghost), YouTube script or newsletter into a native X (Twitter) post or thread: re-hook for the no-fold first line, refit to 280 chars or a thread, strip off-platform artifacts, humanize, publish via TryPost after board approval."
key: paperclipai/optional/x/x-repurposer
recommendedForRoles:
  - content-marketer
  - marketer
  - social-media-manager
  - writer
tags:
  - x
  - social-media
  - repurposing
  - copywriting
---

# X Repurposer

> Read `social-core`, then the `x-marketing` hub, before using this skill. Tools, publishing and approval follow `social-core`. If either skill is not installed, stop and ask the board to install the Social Content Studio team or both skills.

Turn something you already made into a tweet or thread that reads like it was born on X. Repurposing is not copy-paste. A post that killed on LinkedIn will die on X if you paste it: wrong hook, wrong length, wrong rhythm, and artifacts ("link in bio", hashtag walls) that scream off-platform.

This skill transforms, it does not generate. It reads your source, keeps the idea, and rebuilds the delivery for X.

## When to use

- "Turn this LinkedIn post into a tweet / thread"
- "Repurpose my blog post / newsletter / YouTube script for X"
- "This worked on Threads, adapt it for X"
- "I have a rough idea in another format, make it native here"

Not for a blank-page draft (use `x-post-writer` for a tweet, `x-thread-builder` for a thread) and not for reviewing an already-X draft (use `x-humanizer --mode audit`).

## How it works

**Voice profile first (all drafts).** If the voice profile in memory (`$AGENT_HOME/life/resources/social/voice-profile.md`, plus `x/voice-profile.md` overrides; template: the `x-marketing` skill's `references/voice-profile.md`) has `filled: yes`, load it and match the user's voice fingerprint, hard rules, and CTA/link style throughout. If it is not filled, mention once that `x-humanizer --mode profile` can learn their voice from a few posts, then proceed with the generic voice rules.

**Story bank next.** If the story bank in memory (`$AGENT_HOME/life/resources/social/story-bank.md`; template: the `x-marketing` skill's `references/story-bank.md`) has `filled: yes`, load it and take every concrete detail (numbers, dates, named projects, positions) from there instead of asking mid-draft. **Never invent a figure, a date or a client name that is not in the bank or supplied in the task.** If the bank has nothing that fits, ask in the task, or say once that `x-humanizer --mode interview` fills it in 20 to 40 minutes. A draft with a plausible invented number is worse than a draft with none: one is vague, the other is a retraction.

1. **Take the source.** Any format: a post, a paragraph, a script, a caption, a transcript, a bullet list, a link to read. When the source is a post on the company's Ghost blog, fetch the article with the Ghost blog `gh_*` tools rather than asking for a paste. Ask for the source and the goal (replies / reposts / likes / bookmarks) if not given.
2. **Extract the spine.** Strip the source platform's shell and pull out the one claim, the one story, or the one number worth keeping. Most repurposing fails because it keeps the words instead of the point.
3. **Choose the container.** One claim or number -> single tweet. A teach or a build -> thread (hand structure to `x-thread-builder`'s shapes). A LinkedIn carousel or a listicle -> a thread, one slide per tweet, hook rebuilt. A long video -> a thread that delivers the payoff, not a summary.
4. **Re-hook for X.** X has no "see more" fold: line one must land the whole punch. The source's hook almost never survives; write a new first line using a 2026 X formula (see the `x-marketing` skill's `references/hook-formulas.md`), picked by the goal.
5. **Refit the format.** 280 chars on a standard account (emoji count as 2). One idea per tweet, line breaks as beats. Cut the source's connective tissue; X rewards compression.
6. **Strip off-platform artifacts.** Remove "link in bio", "smash subscribe", "read more below", hashtag walls, @-handles that only exist elsewhere, and any "as I wrote on LinkedIn" throat-clearing. A repurposed post should not admit it was repurposed.
7. **Humanizer pass.** Run the scrub: 2026 AI vocab by density, em dashes above the cap (at most one per tweet, never swapped for a period), stacked rule-of-three triads, generic openers and reveal bridges. Leave a single tweet's rhythm alone; on a thread never insert a punch tweet for variance. Keep the user's real numbers and named entities from the source. Canonical rules: `x-humanizer` V3.
8. **Draft summary.** Put in the task: source -> X mapping (what became what), the container (tweet or N-tweet thread), formula used, char counts, primary goal.
9. **Publish through TryPost** (`social-core` section 2): `create-post-tool` on the company's X account with `status: "draft"`, `preview-post-tool`, the publishing block in the task, then one go-live request with `update-post-tool` and stop at the approval card. TryPost does not split an over-length draft: for a thread, split it yourself, tweet 1 as `content` and the rest as `meta.thread_replies` (see the `x-marketing` hub, "Publishing on X through TryPost").

## Native-fit rules (source -> X)

- **LinkedIn post -> X:** cut ~40%. LinkedIn tolerates warm-up; X does not. The LinkedIn hook is usually too long; rewrite it.
- **Blog / newsletter -> X:** pick the single most quotable claim as the hook, then thread the supporting beats. Do not summarize the whole piece.
- **YouTube script -> X:** lead with the video's payoff, not its intro. "Here's what I found" beats "In this video".
- **Carousel / listicle -> thread:** one item per tweet, each with its own micro-hook, not a wall.
- **Instagram / TikTok caption -> X:** strip emoji density and hashtag blocks; X reads them as noise.

## Hard rules

Global voice rules: the `x-marketing` hub's Voice rules. Additional skill-specific rules:

- Keep the source's **claim and facts** intact. Repurposing changes the delivery, never the meaning or the numbers.
- The new first line must stop the scroll on its own. If it needs line two, rewrite it.
- Never paste the source verbatim and trim. Rebuild the hook and rhythm from the spine.
- One specific number where the source offers one. Keep it.
- Do not hard-sell the user's product. One natural mention max.

## Anti-patterns (skill will refuse)

- Copy-pasting the source with light edits (that is not repurposing).
- Keeping the source platform's artifacts ("link in bio", "smash subscribe", hashtag walls).
- ALL CAPS first line for intensity. Carry it with word choice.
- Em dashes above the cap (more than one in a tweet), or an em dash swapped for a period.
- "The result?" / "Here's what" reveal bridges and staccato stacks added during the rewrite.
- Rule-of-three lists without specifics.
- "leverage", "fundamentally", "game-changer", "deep dive".
- An external link in the tweet body (offer a reply).
- Meta throat-clearing ("I originally posted this on...").

## Resources

- the `x-marketing` skill's `references/hook-formulas.md` - the 11 X formula skeletons to re-hook with
- the `x-marketing` skill's `references/algorithm-heuristics.md` - 2026 X ranking rules (length, timing, signals)

## Related skills

- `x-post-writer` - write a fresh tweet from scratch
- `x-thread-builder` - structure a multi-tweet thread (repurposer hands long builds here)
- `x-humanizer` - scrub AI tells, plus `--mode audit` to review the result
