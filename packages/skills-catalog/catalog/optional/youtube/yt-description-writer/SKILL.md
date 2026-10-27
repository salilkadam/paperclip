---
name: yt-description-writer
description: "Write a YouTube or Shorts description under 5,000 chars: a first-150-char hook (the snippet in search and suggested), timestamped chapters, natural keywords, labeled links and one clear CTA. It becomes the content of the TryPost video draft."
key: paperclipai/optional/youtube/yt-description-writer
recommendedForRoles:
  - content-marketer
  - marketer
  - social-media-manager
  - writer
tags:
  - youtube
  - social-media
  - seo
  - descriptions
---

# YouTube Description Writer

> Read `social-core`, then the `youtube-marketing` hub, before using this skill. Tools, publishing and approval follow `social-core`. If either skill is not installed, stop and ask the board to install the Social Content Studio team or both skills.

The description does three jobs: it hooks the reader in its first 150 characters,
it feeds YouTube and Google search, and it organizes the video with chapters and
links. This skill writes all three layers.

## When to use

- User says "write the description for this video"
- User has a video and wants chapters, keywords, and links structured
- User wants the first 150 chars optimized for the search/suggested snippet
- User is about to upload and needs the `content` that ships with the video

## The three layers of a description

| Layer | Chars | Job |
|---|---|---|
| **Hook** | first ~150 | the only text visible before "Show more"; also the search/suggested snippet. Lead with the payoff or the question and the search phrase. |
| **Body** | ~150 to 1,000 | expand the value, restate the promise, place the main keywords naturally, link the key resource. |
| **Furniture** | rest, up to 5,000 | chapters, links, social, credits, hashtags. Skimmable, labeled. |

## Steps

**Voice profile first (all drafts).** If the voice profile in agent memory (`$AGENT_HOME/life/resources/social/voice-profile.md`, with YouTube-only overrides in `$AGENT_HOME/life/resources/social/youtube/voice-profile.md`; template: the `youtube-marketing` skill's `references/voice-profile.md`) has `filled: yes`, load it and match the user's voice fingerprint, hard rules, and CTA/link style throughout. If it is not filled, mention once that `yt-community-post-writer --mode profile` can learn their voice from a few posts, then proceed with the generic voice rules.

**Never invent the specifics.** The rules below ask for a concrete number, a date and a named entity, because that is what separates a real post from a generated one. Take them from what the user actually said in the task or this conversation. **Do not invent a figure, a date, a client name or a result, and do not soften a vague claim into a plausible-looking number.** If the user has nothing concrete for a beat, ask them once, and if they still have nothing, drop the claim rather than decorate it. A published invented number is a retraction; a missing one is only a weaker post.

1. **Gather inputs.** The title (so the description complements it), the video's
   payoff, the main search phrase plus 3 to 5 secondary keywords, the chapter
   beats with timestamps, any links (lead magnet, gear, socials), and whether it
   is long-form or a Short. If a URL is given, read the ids from it (URL table in the `youtube-marketing` hub).
2. **Write the first 150 chars as a second hook.** Lead with the payoff or the
   question, work the primary keyword in naturally, and make it read well as a
   standalone snippet. This is not "welcome back to the channel".
3. **Write the body.** 2 to 4 short paragraphs that restate the promise and place
   the keywords without stuffing. Put the single most important link here.
4. **Add chapters.** Timestamps starting at `0:00`, each label short and
   descriptive. YouTube needs at least 3 chapters and a `0:00` start to enable
   the chapter UI. For a Short, skip chapters.
5. **Add the furniture.** Links section, socials, a one-line CTA (subscribe for
   the specific reason, not "smash like"), and 3 to 5 relevant hashtags at the
   very end (the first 3 surface above the title).
6. **Humanizer pass and length check.** Scrub 2026 AI vocabulary by paragraph
   density (one marker is fine; three in one paragraph means rewrite it), cap
   em dashes at about one per 100 words (replace the excess with a comma,
   colon or line break, never a period), strip reveal bridges and sincerity
   openers ("let me be honest"); never add a hedge or confession the creator
   did not write. Keep the whole thing under 5,000 chars. Confirm the first
   150 read well truncated.
7. **Approval card.** Show the description with a marked 150-char cutoff and the
   total char count.
8. **On approval.** This description is the `content` of the TryPost draft
   (`create-post-tool`, `status: "draft"`); the title travels separately in
   `meta.title`. Going live follows `social-core` section 2. Where TryPost has no
   long-form YouTube type, the description goes in the upload package for
   YouTube Studio (see the `youtube-marketing` hub).

## Hard rules

Global voice rules: see the `youtube-marketing` hub's Voice rules. Additional skill-specific
rules:

- 5,000-char hard cap. The first 150 chars carry the hook and the search phrase.
- The first line is never boilerplate ("Hi everyone, welcome back").
- Chapters: at least 3, first one at `0:00`, short labels. Long-form only.
- Keywords appear in natural sentences, never as a comma-separated dump.
- Hashtags: 3 to 5 max, at the end. More than 15 makes YouTube ignore all of them.
- Every link is labeled so the reader knows what it is before clicking.

## Anti-patterns (skill will refuse)

- A boilerplate greeting in the first 150 chars.
- A keyword dump or a tag wall pretending to be a description.
- 15+ hashtags (YouTube strips them all).
- Em dashes above the cap (more than about one per 100 words), or an em dash swapped for a period.
- "Smash that like button and subscribe" dead phrasing.
- Chapters that do not start at `0:00` (the UI will not render them).
- Raw unlabeled links.

## Resources

- the `youtube-marketing` skill's `references/algorithm-heuristics.md` - the 150-char snippet, chapters, search signals
- the `youtube-marketing` skill's `references/voice-rules.md` - the canonical voice rules
- `references/description-template.md` - the full skeleton with chapters, links, hashtags

## Related skills

- `yt-title-optimizer` - the title the description complements
- `yt-hook-scripter` - the spoken first 30 seconds (different from the written hook)
- `yt-content-planner` - keyword and link strategy across a series
