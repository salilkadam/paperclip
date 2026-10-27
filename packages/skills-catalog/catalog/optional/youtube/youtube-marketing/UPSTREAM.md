# Upstream

The YouTube skills in this category (`youtube-marketing` and the nine `yt-*`
skills) are adapted from Sergey Bulaev's YouTube skills bundle.

- Repository: https://github.com/sergebulaev/youtube-skills
- Commit: `0829e029a5b32af24d898ff10fbc35f804cd92c8`
- Licence: MIT (full text below)
- Upstream root skill name: `youtube-marketing` (kept)

## What changed

- **Layout.** The upstream root `SKILL.md` and root `references/` became this hub
  skill. Each `skills/<slug>/` became its own catalog skill
  (`paperclipai/optional/youtube/<slug>`) with its own `references/` (and, for
  `yt-community-post-writer`, its `sub-skills/`). Links to `../../references/X.md`
  now read "the `youtube-marketing` skill's `references/X.md`".
- **Frontmatter.** Catalog fields added (`key`, `recommendedForRoles`, `tags`);
  descriptions shortened to the catalog's 300-character limit and stripped of
  Publora mentions.
- **Header.** Every leaf starts with "Read `social-core`, then the
  `youtube-marketing` hub".
- **Publishing.** Publora (`create-post`, `get-upload-url`, `update-post`,
  `platformSettings.youtube.*`, `lib.publish`) replaced by the TryPost draft ->
  preview -> publishing block -> one go-live request -> approval card flow in
  `social-core` section 2. The title moves to TryPost `meta.title`.
- **What TryPost takes (observed 2026-10-27).** The workspace's
  `list-content-types-tool` listed only `youtube_short` (vertical, up to 180 s,
  1 GB) for YouTube, with no long-form type, community-post type or thumbnail
  field. So: Shorts upload through TryPost; long-form uploads go through TryPost
  only if a long-form type is listed at run time, otherwise the skills deliver an
  upload package for YouTube Studio; community posts are a copy-paste block
  unless a community-post type is listed; the custom thumbnail is attached
  through TryPost only if a thumbnail field is listed, otherwise set in Studio.
  Upstream also had no community-post endpoint and made it copy-paste.
- **Reading.** Upstream read through the YouTube Data API v3 (its own client and
  `YOUTUBE_API_KEY`) and explicitly had no connector path. Replaced by the
  company's Apify connection with `streamers/youtube-scraper` and
  `streamers/youtube-comments-scraper`. New file `references/mcp-read-layer.md`
  (written for this adaptation, not upstream) maps each upstream read
  (`fetch_video_comments`, `fetch_video_stats`, `fetch_channel_stats`,
  `fetch_trending`) to actor inputs read from the actors' published input
  schemas, with field mappings. Approximations, stated in that file: commenter
  channel URLs are not returned; comment times are relative text; channel stats
  come attached to a video row; "trending" (YouTube's `mostPopular` chart by
  region/category) becomes a niche search sorted by views or date. Quota advice
  for the Data API became Apify cost advice.
- **URL parsing.** `lib/url_parser.py` dropped; the accepted URL shapes and
  fields it returned are written out in the hub's URL table.
- **Images.** Pixfaro (`lib.illustrate`, `refine`, model/cost guard) replaced by
  Loc-GenImage (`gi_generate_image`, `gi_edit_image`, `gi_text_edit_image` for
  legible overlay text, `gi_upscale_image`). `yt-thumbnail-brief` can now render
  the approved concept with Loc-GenImage (upstream only wrote the brief).
- **Video.** The video is supplied by the task or made with
  `marketing-video-studio` / `motion-explainer-studio`; Shorts cuts via
  Loc-FFmpeg. Blog sources for `yt-repurposer` can be fetched with the Ghost blog
  `gh_*` tools.
- **Memory.** The voice profile is written to
  `$AGENT_HOME/life/resources/social/voice-profile.md` (or
  `.../social/youtube/voice-profile.md`), not to `references/voice-profile.md`,
  which stays an empty template. This bundle has no story bank upstream.
- **Approval.** "The user replies publish/yes" became the TryPost approval card;
  a chat or comment reply is never an approval. Comment replies found by
  `yt-audience-insights` are delivered as copy-paste blocks.
- **Untrusted content.** `references/untrusted-content.md` kept; the
  `YOUTUBE_SKILLS_CUSTOM_POSTER` and Data API wording replaced with the Apify reads
  and the approval card.
- **Setup.** The Tier 0/1/2 prerequisites (sign-up links, `.env`, `pip install`,
  custom poster) replaced by one line pointing at `social-core` section 6.

## What was dropped

- `lib/` (Publora, Pixfaro, YouTube Data API and URL-parser clients, approval and
  backend helpers), `scripts/`, `requirements*.txt`, `.env.example`, `.github/`,
  `.claude-plugin/`, `.codex-plugin/`, `.codex-marketplace/` (a mirror of the
  same skills), `.agents/`, `CLAUDE.md`, `AGENTS.md`, `SECURITY.md`, `README.md`
  (its skill list and voice rules are in the hub), `assets/hero.png`,
  `assets/social-preview.jpg`. `assets/icon.svg` is kept.
- The hub's "Resources" and "Acknowledgments" sections (Publora links and the
  Python client) and the "After a successful run" request to star the upstream
  repository (not appropriate inside a company's agent runs).

## Licence

MIT License

Copyright (c) 2026 Sergey Bulaev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
