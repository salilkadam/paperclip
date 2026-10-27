---
name: youtube-marketing
description: "Hub for the YouTube and Shorts skills: high-CTR titles, SEO descriptions with chapters, first-30-second hook scripts, thumbnail briefs, community posts, weekly upload plans. Holds the shared references (voice rules, hook formulas, algorithm, thumbnails, Apify read layer)."
key: paperclipai/optional/youtube/youtube-marketing
recommendedForRoles:
  - content-marketer
  - marketer
  - social-media-manager
  - video-producer
  - content-strategist
tags:
  - youtube
  - social-media
  - video
  - youtube-shorts
---

# YouTube Marketing Skills

> Read `social-core` first. Tools, publishing and approval follow `social-core`.

A bundle of 9 focused skills for YouTube content ops in 2026, covering both
long-form and YouTube Shorts. Each skill is single-purpose, follows the draft
then approval then publish pattern, and uses TryPost (through the Paperclip tool
gateway, see `social-core` section 2) for uploading and scheduling the video.

## When to use this bundle

- **Writing high-CTR titles** (curiosity, number, how-I, comparison) with A/B variants -> use `yt-title-optimizer`
- **Writing the description** (first-150-char hook, chapters, keywords, links) -> use `yt-description-writer`
- **Scripting the first 30 seconds for retention** (or the first 3 seconds of a Short) -> use `yt-hook-scripter`
- **Briefing a thumbnail** (text overlay, face/emotion, contrast) plus the upload flow -> use `yt-thumbnail-brief`
- **Writing a community-tab post or poll** -> use `yt-community-post-writer`
- **Planning a week of uploads** (long-form vs Shorts mix, title/thumbnail pairing) -> use `yt-content-planner`
- **Repurposing off-platform content** (a blog post, thread, or LinkedIn post) into a YouTube community post or a video brief -> use `yt-repurposer`
- **Auditing and rewriting the channel page** (banner, trailer, About, playlists, section order) to convert viewers into subscribers -> use `yt-channel-optimizer`
- **Reading your audience from the comments (who commented, themes, superfans, trending)** -> use `yt-audience-insights`

## Core pattern

Every action-taking skill follows three steps:

1. **Parse the input.** If the task gives a YouTube URL, read the video id,
   Short id, channel, or handle from it using the URL table below.
2. **Draft the content.** The skill applies 2026 research (title and hook
   formulas, CTR x retention heuristics, thumbnail principles, voice rules) and
   puts the draft in the task.
3. **Wait for approval.** Going live is the board's call, through the TryPost
   approval card (`social-core` section 2). A reply like "publish" or "yes" in
   chat or a comment is not an approval; only the card is.

## Why YouTube is video-first (read this once)

YouTube is a **video-only platform**: every published post requires a single
video file. The skills write the title, description, hook script, and thumbnail
brief; the video itself comes from the task, or is produced with
`marketing-video-studio` (live action, promos, ads) or `motion-explainer-studio`
(2D explainers). Clips for Shorts are cut and transcoded with Loc-FFmpeg. The
upload follows the TryPost flow (`trypost` skill, `social-core` section 2):

1. `get-workspace-tool`, `list-social-accounts-tool` (the company's own YouTube
   channel), then `list-content-types-tool` for the YouTube content type, its
   media rules and its required `meta`.
2. Attach the video: a public direct file URL in `media[].url`, or
   `request-media-upload-tool`, upload, then attach with `media: [{ id: <media_id> }]`.
3. `create-post-tool` with `status: "draft"`, the description as `content`, and
   the title in `meta.title`.
4. `preview-post-tool`, the publishing block in the task, then one go-live
   request with `update-post-tool` (`status: "scheduled"` plus `scheduled_at`).
   The approval card goes to the board.

**What TryPost can take (checked 2026-10-27, re-check every run).** The YouTube
platform in `list-content-types-tool` listed one content type, `youtube_short`
(vertical video up to 3 minutes, 1 GB, video only), and no long-form, community
post or thumbnail field. So:

- **Shorts** go through the TryPost flow above.
- **Long-form videos** go through TryPost only if `list-content-types-tool`
  lists a long-form YouTube type at run time. Otherwise deliver an **upload
  package** in the task for a human to upload in YouTube Studio: the video file
  (or its URL), the approved title, description, thumbnail image URL, chapters,
  and the intended publish time (channel timezone and UTC). Say in the task that
  TryPost had no long-form type.

Thumbnail images are generated with Loc-GenImage (see `yt-thumbnail-brief`).
Whether TryPost can set a custom YouTube thumbnail is decided by
`list-content-types-tool` at run time; if it lists no thumbnail field, the
thumbnail is set by a human in YouTube Studio. YouTube community-tab posts are
delivered as a copy-paste block unless `list-content-types-tool` lists a
community-post type (see `yt-community-post-writer`).

**Setup:** see `social-core` section 6. Without an Apify connection the read steps fall back to pasted text.

### Reading YouTube data

`yt-audience-insights` and the planner read comments, video and channel stats
and what is working in a niche through the company's Apify connection
(`streamers/youtube-scraper`, `streamers/youtube-comments-scraper`). The actors,
exact input names and the field mapping are in `references/mcp-read-layer.md`.
Without the connection, ask in the task for the titles, stats or comments and
say why. With neither a read nor a paste, do not estimate the numbers.

### Note on community posts

YouTube community-tab posts and polls have no public API. So
`yt-community-post-writer` returns its draft as a copy-paste block for a human
to post in the Community tab, unless `list-content-types-tool` at run time lists
a community-post type for the company's YouTube account. Videos and Shorts
upload and schedule through TryPost normally.

## Voice rules (baked into every skill)

1. Em dashes (`—`) capped at about 1 per 100 words (at most one in a title or community post; `..` in a spoken line); replace the excess with a comma, colon or line break, never a period. No en dashes between clauses, no double dashes.
2. Use `..` as a soft pause in a script line when rhythm calls for it.
3. Capitalize all personal, company, and product names.
4. Specific numbers beat adjectives. "in 28 days" beats "fast".
5. Title is a promise, not a summary. Curiosity plus a concrete payoff.
6. Title and thumbnail are a pair. They never repeat the same words.
7. The first 30 seconds (or 3 on a Short) is the real algorithm. No intro.
8. Title caps at 100 chars (sweet spot 40 to 60). Description caps at 5,000, first 150 visible.
9. Avoid AI vocabulary clusters: one 2026 marker (`leverage`, `significant`, `streamline`, `foster`) in a paragraph is English, three in one paragraph reads as AI and the paragraph gets rewritten; in a one-line title any marker goes. No sincerity openers ("let me be honest", "not gonna lie").
10. Do not keyword-stuff. Natural language with the real search phrase once.

(Canonical reference: `references/voice-rules.md`. See also
`references/hook-formulas.md`, `references/algorithm-heuristics.md`,
`references/thumbnail-principles.md`, `references/mcp-read-layer.md` and
`references/untrusted-content.md`. The voice profile template is
`references/voice-profile.md`; the filled copy lives in agent memory at
`$AGENT_HOME/life/resources/social/voice-profile.md`, with YouTube-only
overrides in `$AGENT_HOME/life/resources/social/youtube/voice-profile.md`.)

## How YouTube URLs map

| URL shape | Parsed to |
|---|---|
| `https://www.youtube.com/watch?v=VIDEO_ID` | video_id, type `video` |
| `https://youtu.be/VIDEO_ID` | video_id, type `video` |
| `https://www.youtube.com/shorts/VIDEO_ID` | video_id, `is_short: true`, type `short` |
| `https://www.youtube.com/@handle` | handle, type `channel` |
| `https://www.youtube.com/channel/UC...` | channel_id, type `channel` |

Also accepted: `m.youtube.com/watch?v=`, `youtube.com/embed/`, `/live/` and
`/v/` (all type `video`), and the legacy `youtube.com/c/Name` and
`youtube.com/user/Name` (type `channel`, the name read as a handle). A video id
is the canonical 11-character base64url token (`A-Z a-z 0-9 _ -`). Shorts share
the same id space as regular videos; `is_short` records which surface the URL
pointed at (it affects how the hook-scripter and content-planner treat it). Read
these fields from the URL yourself: `{video_id, handle, channel_id, is_short,
url_type, canonical_url}`.

## Known gotchas

- **A video is required.** A text-only YouTube post fails at publish. Always use
  the draft -> attach video -> schedule flow. The exception is a community post,
  which is not a video upload (and has no public API, so it is copy-paste unless
  TryPost lists a community-post type).
- **Title defaults to empty.** If you do not set `meta.title`, the first line of
  the content becomes the title. Always set it.
- **Content becomes the description.** The `content` you pass is the video
  description; the title is separate in `meta.title`.
- **Thumbnail is separate from the upload.** Generate it, then check
  `list-content-types-tool` for a thumbnail field. If there is none, hand the
  image to a human for YouTube Studio (verified channel, JPEG/PNG <= 2 MB). A
  rejected thumbnail does not block the video.
- **Upload size and length.** TryPost caps uploads below YouTube's native limit
  (1 GB and 180 seconds for `youtube_short` when checked); read the media rules
  from `list-content-types-tool`. Compress with Loc-FFmpeg or
  hand the file to a human for YouTube Studio if it is too large.
- **CTR is only half the product.** A title that over-promises and loses the
  first 30 seconds is punished harder than a modest title. Pair every title with
  a hook that keeps it.
