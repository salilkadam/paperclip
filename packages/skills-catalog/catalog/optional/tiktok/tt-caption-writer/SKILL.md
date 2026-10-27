---
name: tt-caption-writer
description: "Write a TikTok caption under 2,200 chars with a 3-5 mixed-reach hashtag set and the post settings (privacy level, comments, duet, stitch, commercial disclosure). Front-loads a reason to comment, runs the humanizer pass, then a TryPost draft of the video. Not for the in-video hook."
key: paperclipai/optional/tiktok/tt-caption-writer
recommendedForRoles:
  - content-marketer
  - marketer
  - social-media-manager
  - writer
tags:
  - tiktok
  - social-media
  - captions
  - hashtags
---

# TikTok Caption Writer

> Read `social-core`, then the `tiktok-marketing` hub, before using this skill. Tools, publishing and approval follow `social-core`. If either skill is not installed, stop and ask the board to install the Social Content Studio team or both skills.

Write the caption that sits under the video: a tight caption inside the 2,200
char API limit, a mixed-reach hashtag set, and the TikTok post settings (TryPost
`meta`) that control reach and interaction. On TikTok the caption supports the
video, it does not carry it. The hook is in the first 1-3 seconds of the clip
(see `tt-hook-scripter`); the caption's job is to add context and earn a comment.

## When to use

- User has a video (or a script) and needs the caption, hashtags, and settings
- User is about to upload and wants the posting flags right
- User wants a rendered .mp4 drafted in TryPost, ready for the board's approval card

## What this skill produces

- **Caption** (<= 2,200 chars on the API; aim much shorter), first line front-
  loaded with a reason to read or comment
- **Hashtag set** (3 to 5, mixed reach), placed at the end
- **TikTok settings** (`meta.privacy_level` plus flags) with a plain-English summary
- The TryPost draft with the video attached, and one go-live request that
  raises the approval card, when a rendered video exists

## The TikTok settings (TryPost `meta`)

Call `get-tiktok-creator-info-tool` with the company's TikTok `account_id`
first; full matrix in `references/settings-matrix.md`.

| Setting | Values / default | What it does |
|---|---|---|
| `privacy_level` | PUBLIC_TO_EVERYONE (default), MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR, SELF_ONLY | who can view. Required; pick one of the creator info's `privacy_level_options` |
| `allow_comments` | true (default) | viewers can comment |
| `allow_duet` | false (default) | viewers can Duet |
| `allow_stitch` | false (default) | viewers can Stitch |
| `disclose` | false (default) | the video is commercial |
| `brand_organic_toggle` | false (default) | promoting your own brand |
| `brand_content_toggle` | false (default) | paid partnership / sponsored |
| `is_aigc` | false (default) | AI-generated content label; true for in-house generated video |

### Two gotchas you must surface in the task

1. **Boolean inversion bug (upstream publisher).** The publisher these skills
   were written for mapped `allowComments`, `allowDuet`, `allowStitch` to
   TikTok's `disable_*` flags, so the booleans could land inverted. That is not
   known for TryPost, but it cannot be confirmed from the tool description
   alone. **Check the live post once before trusting these values.** Say so
   whenever a flag changes. Flags the creator info reports disabled stay false.
2. **Commercial disclosure.** If `disclose` is true, at least one of
   `brand_organic_toggle` (your own brand) or `brand_content_toggle` (paid
   partnership) must also be true, or the post is rejected. `SELF_ONLY` cannot
   be combined with `brand_content_toggle`. Check this before drafting.

### Posting reality

- **Unaudited apps post PRIVATE only.** Until the publishing app passes TikTok's
  review, posts are forced to `SELF_ONLY` regardless of `privacy_level`. Say so
  in the task if a "public" post lands private.
- For reach, use `PUBLIC_TO_EVERYONE`. For an end-to-end test, use `SELF_ONLY`.

## Steps

**Voice profile first (all drafts).** If the voice profile in memory (`$AGENT_HOME/life/resources/social/voice-profile.md`, with overrides from `$AGENT_HOME/life/resources/social/tiktok/voice-profile.md`) has `filled: yes`, load it and match the user's voice fingerprint, hard rules, and CTA/link style throughout. If it is not filled, mention once that `tt-humanizer --mode profile` can learn their voice from a few posts, then proceed with the generic voice rules.

**Never invent the specifics.** The rules below ask for a concrete number, a date and a named entity, because that is what separates a real post from a generated one. Take them from what the user actually said in this conversation. **Do not invent a figure, a date, a client name or a result, and do not soften a vague claim into a plausible-looking number.** If the user has nothing concrete for a beat, ask them once, and if they still have nothing, drop the claim rather than decorate it. A published invented number is a retraction; a missing one is only a weaker post.

1. **Gather inputs, goal first.** Ask (or infer) what the caption should earn,
   then shape for it: comments -> end on one specific question tied to the video;
   saves -> promise reference value ("the 3 settings are in the caption");
   shares -> a claim people will want to show someone; profile taps -> an open
   loop the pinned video pays off. Then gather the video topic/script, the
   niche, whether it is commercial, and whether a rendered
   .mp4 path exists.
2. **Draft the caption.** Front-load the first visible line with a reason to read
   or a specific question to comment on. Keep it tight. Em dashes under the cap
   (about one per 100 words; a short caption rarely needs one), no AI vocab
   cluster. Optionally restate the hook's open loop as a comment prompt.
3. **Pick hashtags.** 3 to 5, mixed reach: one broad, one to two niche-defining,
   one to two specific to the video. Put them at the end. Never stuff.
4. **Set the flags.** Default to `PUBLIC_TO_EVERYONE`, comments on, duet/stitch
   off, no commercial flags (`disclose` + `brand_organic_toggle` when the video
   promotes the company's own product). Adjust per the task, keep within the
   creator info, and surface the two gotchas.
5. **Char check.** Confirm caption + hashtags <= 2,200. If over, tighten.
6. **Humanizer pass.** Scrub 2026 AI vocab by density, cap em dashes (about
   one per 100 words, never swap one for a period), break stacked triads,
   generic openers, reveal bridges and sincerity openers ("not gonna lie").
   Leave the rhythm alone; never chop a line for punch. Canonical rules:
   `tt-humanizer` V3.
7. **Approval card.** Show in the task: caption, char count, hashtag set, settings summary,
   and the resolved `privacy_level` (flag if it may post private).
8. **Publish through the board.** With a rendered video (from
   `marketing-video-studio` / `motion-explainer-studio`, cut with Loc-FFmpeg,
   or supplied by the task), follow the publish flow in the `tiktok-marketing`
   hub and `social-core` section 2: `create-post-tool` on the company's TikTok
   account with `status: "draft"`, `content_type: "tiktok_video"`, the caption,
   `media: [{ url }]` or `[{ id }]`, and the settings as `meta`;
   `preview-post-tool`; the publishing block in the task; then one go-live
   request with `update-post-tool` that raises the approval card. Without a
   video, deliver the caption and settings as a copy-paste block to upload
   in-app.

## Hard rules

Global voice rules: see the `tiktok-marketing` hub's Voice rules. Additional skill-specific
rules:

- Caption + hashtags must fit 2,200 chars (API), hashtags included. Aim far under.
- 3 to 5 hashtags, mixed reach, at the end. Never 10+, never mid-sentence.
- The caption never does the hook's job. The hook is in the video.
- Always set `privacy_level` from the creator info's options. Never ship an empty value.
- Surface the boolean inversion warning whenever an interaction flag changes.

## Anti-patterns (skill will refuse)

- Hashtag walls (10+), or hashtags jammed into the sentence.
- Em dashes above the cap (more than about one per 100 words), or an em dash swapped for a period.
- "The result?" reveals and "No X. No Y. Just Z." staccato stacks added for punch.
- "Follow for part 2 / like and subscribe / don't forget to share" stacks.
- A caption that repeats the spoken hook word for word.
- `disclose: true` with neither brand flag set.
- Claiming a post will be public when the app is unaudited (it will be private).

## Resources

- the `tiktok-marketing` skill's `references/voice-rules.md` - caption and hashtag rules
- the `tiktok-marketing` skill's `references/algorithm-heuristics.md` - caption, hashtag, and settings heuristics
- `references/settings-matrix.md` - every TikTok `meta` value, defaults, and the known bugs
- `trypost` skill - `get-tiktok-creator-info-tool`, draft/approval flow, media attach quirk

## Optional illustration

Offer a generated image when a visual would lift reach. Draft a prompt and call
Loc-GenImage `gi_generate_image` (9:16), pulling brand handle/color from Voice &
Brand Profile section 6 and setting text with `gi_text_edit_image` so it is legible. Show the returned URL;
for a TikTok photo post (`content_type: "tiktok_photo"`), attach the images via `media: [{ url }]`; for a video, TikTok's API has no cover-image field, so design the opening frame as the cover (or set the video media item's `meta.cover_offset_ms` if `list-content-types-tool` reports `supports_video_cover` for TikTok). Full workflow (incl. quote-cards):
`tt-humanizer`'s `sub-skills/illustration.md`. No ready Loc-GenImage connection -> it drafts the prompt in the task for the image to be supplied.
## Related skills

- `tt-hook-scripter` - the in-video hook (the caption does not replace it)
- `tt-humanizer` - scrub the caption before publishing
- `tt-content-planner` - schedule captions across a posting week
