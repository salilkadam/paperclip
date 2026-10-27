---
name: facebook-marketing
description: "Hub for the Facebook Page skills: short punchy Page posts and story posts, AI-tell removal and pre-publish audit, hook teardowns, comment replies, weekly plans, Page audits and Page/commenter reads. Holds the shared references (voice rules, hook formulas, algorithm, Apify read layer)."
key: paperclipai/optional/facebook/facebook-marketing
recommendedForRoles:
  - content-marketer
  - marketer
  - social-media-manager
  - content-strategist
  - writer
tags:
  - facebook
  - social-media
  - facebook-pages
  - community
---

# Facebook Pages Marketing Skills

> Read `social-core` first. Tools, publishing and approval follow `social-core`.

A bundle of 8 focused skills for Facebook Page content ops in 2026. Each skill is
single-purpose, follows the draft then approval then publish pattern, and uses
TryPost (through the Paperclip tool gateway, see `social-core` section 2) for
posting to the company's Facebook Page.

## When to use this bundle

- **Writing a short punchy Page post or a longer story post** -> use `fb-post-writer`
- **Removing AI tells from a draft, or auditing it before posting** -> use `fb-humanizer` (rewrite plus `--mode audit` pre-publish review, which folds in the post-audit sub-tool)
- **Repurposing a LinkedIn post, X thread, blog, or newsletter into a native Page post** -> use `fb-repurposer`
- **Reverse-engineering the hook from a high-share Page post** -> use `fb-hook-extractor`
- **Drafting replies to comments on your Page's posts** -> use `fb-engagement-drafter`
- **Planning a week of Facebook Page content** -> use `fb-content-planner`
- **Auditing and rewriting the Page itself (name, cover, About, CTA button, pinned post)** -> use `fb-page-optimizer`
- **Reading a Page's stats (yours or a competitor's) or the commenters on a post from real data** -> use `fb-audience-insights`
- **Working out what you actually have to say, or having nothing concrete for a draft to use** -> use `fb-humanizer --mode interview`. It interviews you and fills the Story Bank every writing skill reads before drafting.

## Core pattern

Every action-taking skill follows three steps:

1. **Parse the input.** If the task gives a Facebook Page post URL, read the
   page and post id from it using the URL table below.
2. **Draft the content.** The skill applies 2026 research (Facebook hook
   formulas, the under-80-char engagement sweet spot, timing, voice rules,
   ranking heuristics) and puts the draft in the task.
3. **Wait for approval.** Going live is the board's call, through the TryPost
   approval card (`social-core` section 2). A reply like "post" or "yes" in chat
   or a comment is not an approval; only the card is.

## Publishing a Page post

1. `get-workspace-tool`, then `list-social-accounts-tool`: pick the company's own
   **Facebook Page** account (platform `facebook`), never a personal profile or
   another company's Page.
2. `list-content-types-tool`: when last checked (2026-10-27) the Facebook Page
   platform listed `facebook_post` (text-only allowed; up to 10 images or videos;
   images up to 4 MB), `facebook_reel` (one video up to 90 seconds, vertical) and
   `facebook_story` (one vertical image or video up to 60 seconds, no text).
   Re-check at run time.
3. Media: images from Loc-GenImage (public URL in `media[].url`), video from
   `marketing-video-studio` / `motion-explainer-studio`, Reels cut with
   Loc-FFmpeg. Attach by URL or `media: [{ id: <media_id> }]` after
   `request-media-upload-tool`.
4. `create-post-tool` with `status: "draft"`, then `preview-post-tool`, the
   publishing block in the task, and one go-live request with `update-post-tool`
   (`status: "scheduled"` plus `scheduled_at`, or `status: "publishing"`). The
   approval card goes to the board.

**Setup:** see `social-core` section 6. Without an Apify connection the read steps fall back to pasted text.

### Note on comment replies

TryPost publishes posts to the company's own accounts; it does not post replies
to comments. So `fb-engagement-drafter` returns its approved drafts as
copy-paste blocks for a human to post as replies in Facebook or Meta Business
Suite. The same applies to a link "in the first comment" (`fb-repurposer`): the
post goes through TryPost, the first comment is a copy-paste block. Page posts
publish through TryPost normally.

## Voice rules (baked into every skill)

1. Em dashes (`—`) capped at about 1 per 100 words (0-1 in a short post, 1-2 in a story post); replace the excess with a comma, colon or parentheses, never a period. No en dashes between clauses, no double dashes.
2. Use `..` as a soft pause when rhythm calls for it.
3. Capitalize all personal, company, and product names. Lowercase a brand reads
   as careless.
4. Write for a Page (a warm business voice), not a personal profile and not a
   faceless corporate account.
5. Avoid AI vocabulary: `leverage`, `fundamentally`, `streamline`, `harness`,
   `delve`, `unlock`, `foster`.
6. Specific numbers beat adjectives. 2.4x beats "way better".
7. One idea per post. Two ideas means two posts.
8. Lead short. Posts under 80 chars get a reported ~66% engagement lift.
9. The first line carries everything (Facebook folds longer posts behind "See more").
10. 0-2 hashtags, 0-2 emoji, and only when each earns its place.

(Canonical reference: `references/voice-rules.md`. See also
`references/hook-formulas.md`, `references/algorithm-heuristics.md`,
`references/mcp-read-layer.md` and `references/untrusted-content.md`.)

## How Facebook Page URLs map

| URL shape | Parsed to |
|---|---|
| `https://www.facebook.com/PAGE/posts/ID` | page + post_id, type `post` |
| `https://www.facebook.com/permalink.php?story_fbid=ID&id=PAGEID` | post_id + page, type `post` |
| `https://www.facebook.com/watch/?v=ID` | post_id (video), type `post` |
| `https://www.facebook.com/share/p/TOKEN/` | share_token, type `share` (ids hidden) |
| `https://www.facebook.com/PAGE` | page, type `profile` |
| `https://fb.com/PAGE` | normalized to www.facebook.com |

Read these fields from the URL yourself: `{page, post_id, share_token,
url_type, canonical_url}`. A `share/p/` link hides the page and post ids behind
an opaque token, so flag it and ask in the task for the post text.

## Known gotchas

- **The under-80-char sweet spot is real.** Posts under 80 characters get a
  reported ~66% engagement lift. Lead short; go long only on purpose.
- **Text-only Page posts are fully supported**, unlike Instagram, TikTok, and
  YouTube. You do not need media to post.
- **External links suppress organic reach.** A link post still drives traffic but
  reaches fewer people than a native text, photo, or video post.
- **Pages only, never personal profiles.** TryPost (and the Facebook API) cannot
  post to a personal profile via a third-party app.
- **Page tokens last 59 days.** TryPost holds the Page connection. If posts start failing with no clear error, put the task in `blocked` and ask a
  board member to reconnect the Page in TryPost.
- **No Facebook comment path.** Comment replies are draft-only by design; the
  engagement drafter returns a copy-paste block.

## Memory

- `references/story-bank.md` - what you have to say, filled by the interview
  (empty template; the filled copy lives at
  `$AGENT_HOME/life/resources/social/story-bank.md`)
- `references/voice-profile.md` - how you sound, filled by `--mode profile`
  (empty template; the filled copy lives at
  `$AGENT_HOME/life/resources/social/voice-profile.md`, with Facebook-only
  overrides in `$AGENT_HOME/life/resources/social/facebook/voice-profile.md`)
