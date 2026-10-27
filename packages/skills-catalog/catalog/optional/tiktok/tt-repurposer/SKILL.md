---
name: tt-repurposer
description: "Repurpose a LinkedIn post, blog article (Ghost), newsletter or X thread into a native TikTok spoken script and caption: hook in the first second, every line sayable in one breath, open on the payoff, a trend angle where it fits, then a rendered video and TryPost draft."
key: paperclipai/optional/tiktok/tt-repurposer
recommendedForRoles:
  - content-marketer
  - marketer
  - social-media-manager
  - writer
  - video-producer
tags:
  - tiktok
  - social-media
  - repurposing
  - cross-platform
---

# TikTok Repurposer

> Read `social-core`, then the `tiktok-marketing` hub, before using this skill. Tools, publishing and approval follow `social-core`. If either skill is not installed, stop and ask the board to install the Social Content Studio team or both skills.

Turn something you already made into a TikTok video script that sounds like it was born on camera. Repurposing is not copy-paste. A post that killed on LinkedIn will die on TikTok if you read it aloud: wrong open, wrong rhythm, sentences no one can say in one breath, and artifacts ("link in bio", hashtag walls, corporate phrasing) that scream off-platform.

This skill transforms, it does not generate. It reads your source, keeps the idea, and rebuilds the delivery as a spoken script plus a short caption for TikTok.

## When to use

- "Turn this LinkedIn post into a TikTok script"
- "Repurpose my blog post / newsletter / X thread for TikTok"
- "This worked on Instagram, adapt it into a video I can film"
- "I have a rough idea in another format, make it native here"

Not for a blank-page hook (use `tt-hook-scripter`), not for the caption on its own (use `tt-caption-writer`), and not for reviewing an already-TikTok script (use `tt-humanizer --mode audit`).

## How it works

**Voice profile first (all drafts).** If the voice profile in memory (`$AGENT_HOME/life/resources/social/voice-profile.md`, with overrides from `$AGENT_HOME/life/resources/social/tiktok/voice-profile.md`) has `filled: yes`, load it and match the user's voice fingerprint, hard rules, and CTA/link style throughout. If it is not filled, mention once that `tt-humanizer --mode profile` can learn their voice from a few posts, then proceed with the generic voice rules.

**Never invent the specifics.** The rules below ask for a concrete number, a date and a named entity, because that is what separates a real post from a generated one. Take them from what the user actually said in this conversation. **Do not invent a figure, a date, a client name or a result, and do not soften a vague claim into a plausible-looking number.** If the user has nothing concrete for a beat, ask them once, and if they still have nothing, drop the claim rather than decorate it. A published invented number is a retraction; a missing one is only a weaker post.

1. **Take the source.** Any format: a post, a paragraph, a newsletter, a thread, a caption, a transcript, a bullet list, a link to read. A company blog post can be fetched with the Ghost blog `gh_*` tools. Ask for the source and the goal (completion / saves / comments / shares) if not given.
2. **Extract the spine.** Strip the source platform's shell and pull out the one claim, the one story, or the one number worth keeping. Most repurposing fails because it keeps the words instead of the point.
3. **Open on the payoff.** TikTok decides in the first second. Lead with the result, not the setup. "Here is the fix" beats "let me walk you through the context". The source's opener almost never survives.
4. **Re-hook for the first second.** Hand the opening line to `tt-hook-scripter`: the spoken line, the on-screen text, and the opening visual firing at once, picked by the goal.
5. **Choose the native shape.** A blog or long post -> a 3-part spoken script (hook, value, loop-close). A listicle -> a fast on-screen-text list script, one item per beat. A long video or transcript -> a script that delivers the single payoff, not a summary.
6. **Make every line sayable.** Rewrite each line so it can be said out loud in one breath: contractions, fragments, short lines. If you cannot read it without stopping for air, cut it.
7. **Add a trend or sound angle where it fits.** If a trending sound or format carries the idea, reference `tt-trend-mapper` to check fit and script the twist. Skip it if forcing a trend would bury the point.
8. **Write the caption.** Hand the short caption to `tt-caption-writer`: under 2,200 chars, 3 to 5 mixed-reach hashtags, TikTok settings.
9. **Strip off-platform artifacts.** Remove "link in bio" from other platforms, hashtag walls beyond a few, "smash subscribe", @-handles that only exist elsewhere, corporate phrasing, and any "as I posted on LinkedIn" throat-clearing. A repurposed script should not admit it was repurposed.
10. **Humanizer pass.** Run `tt-humanizer` V3: it scrubs 2026 AI vocab by density, em dashes above the cap (caption about one per 100 words, card at most one), stacked triads, reveal bridges, sincerity openers and "hey guys" filler, fixes only a teleprompter-flat run (never inserts a punch line), and checks every line is sayable out loud in one breath. Keep the user's real numbers and named entities from the source.
11. **Approval card.** Show in the task: source -> TikTok mapping (what became what), the script (hook / value / loop-close), on-screen text, the trend or sound angle if any, the caption, char counts, primary goal.
12. **Render, then publish through the board.** Brief `marketing-video-studio` (live action) or `motion-explainer-studio` (2D explainer) with the approved script and on-screen text, cut it with Loc-FFmpeg, then follow the publish flow in the `tiktok-marketing` hub and `social-core` section 2: `get-tiktok-creator-info-tool`, `create-post-tool` on the company's TikTok account with `status: "draft"`, the caption, the video as `media`, `meta.privacy_level` and the flags from `tt-caption-writer`; `preview-post-tool`; the publishing block in the task; one go-live request with `update-post-tool` that raises the approval card. Without a rendered .mp4, deliver the script, caption, and settings as a copy-paste block to upload in the TikTok app.

## Native-fit rules (source -> TikTok)

- **LinkedIn post -> TikTok:** cut the warm-up. LinkedIn tolerates a slow build; TikTok does not. Rewrite the hook to open on the payoff, and turn the body into lines you can say out loud.
- **Blog / newsletter -> script:** pick the single most repeatable claim as the spoken hook, then a 3-part script (hook, value, loop-close). Do not narrate the whole piece.
- **Listicle -> on-screen-text list:** one item per beat, each a short spoken line with matching on-screen text, not a wall of bullets.
- **X thread -> script:** the thread's best tweet becomes the hook; the rest become beats you speak. Drop the numbering and the "1/" scaffolding.
- **Long video / transcript -> script:** lead with the payoff, deliver one idea, close the loop. Never a summary.
- **Instagram / any caption -> caption:** strip hashtag blocks down to 3 to 5, drop off-platform CTAs, keep it short.

## Hard rules

Global voice rules: see the `tiktok-marketing` hub's Voice rules. Additional skill-specific rules:

- Keep the source's **claim and facts** intact. Repurposing changes the delivery, never the meaning or the numbers.
- Every line must be sayable out loud in one breath. If it needs a pause for air, cut it.
- The first second must land the whole promise. Open on the payoff, not the setup.
- Never read the source verbatim. Rebuild the hook and rhythm from the spine.
- One specific number where the source offers one. Keep it.
- Do not hard-sell the user's product. One natural mention max.

## Anti-patterns (skill will refuse)

- Copy-pasting the source and reading it aloud (that is not repurposing).
- Keeping the source platform's artifacts ("link in bio", "smash subscribe", hashtag walls, corporate phrasing).
- A slow open that saves the payoff for the end.
- Lines too long to say in one breath.
- Em dashes above the cap in the caption or on a card, or an em dash swapped for a period.
- "The result?" reveals and staccato stacks added for punch.
- Rule-of-three lists without specifics.
- "leverage", "fundamentally", "game-changer", "deep dive", "hey guys".
- Forcing a trending sound that buries the point.

## Resources

- the `tiktok-marketing` skill's `references/hook-formulas.md` - the 10 TikTok 3-second hook formulas to re-hook with
- the `tiktok-marketing` skill's `references/algorithm-heuristics.md` - 2026 TikTok ranking rules (completion, rewatch, shares, sound timing)
- the `tiktok-marketing` skill's `references/voice-rules.md` - the canonical spoken-script and caption voice rules

## Related skills

- `tt-hook-scripter` - script the first-second hook (repurposer hands the open here)
- `tt-trend-mapper` - check trend fit and script the twist for a sound angle
- `tt-caption-writer` - write the caption, hashtags, and settings (repurposer hands the caption here)
- `tt-humanizer` - scrub AI tells and check lines are sayable, plus `--mode audit` to review the result
