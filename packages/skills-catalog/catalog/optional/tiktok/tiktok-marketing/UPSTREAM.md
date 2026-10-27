# Upstream

- Repository: https://github.com/sergebulaev/tiktok-skills
- Commit: `e050b345a7b3ec417bf5c5b34d4161806b5d07f4`
- Author: Sergey Bulaev
- License: MIT (full text below)
- Upstream root skill name: `tiktok-marketing` (kept unchanged)

## What changed

- Root `SKILL.md` became this hub (`tiktok-marketing`). Leaf skills moved from
  `skills/<slug>/` to sibling catalog directories
  `paperclipai/optional/tiktok/<slug>` (8 leaves, all kept).
- Frontmatter rewritten for the Paperclip catalog (`key`, `recommendedForRoles`,
  `tags`); every description shortened to 300 characters or less and stripped
  of Publora mentions.
- Every leaf gained the header line pointing to `social-core` and this hub.
  `../../references/X.md` and `../../../references/X.md` became "the
  `tiktok-marketing` skill's `references/X.md`".
- Publishing: the Publora draft -> S3 upload -> schedule flow, `lib.publish`,
  `lib.tiktok_settings`, `lib/publora_client.py` and the custom-poster tier were
  replaced by the TryPost flow of `social-core` section 2, with
  `get-tiktok-creator-info-tool` before every TikTok draft and
  `meta.privacy_level` chosen from its `privacy_level_options`.
- Settings (`tt-caption-writer`, `settings-matrix.md`,
  `algorithm-heuristics.md`, audit checklist): Publora `platformSettings.tiktok`
  fields were mapped to TryPost `meta` names taken from the TryPost
  `create-post-tool` description: `viewerSetting` -> `privacy_level`,
  `allowComments`/`allowDuet`/`allowStitch` -> `allow_comments`/`allow_duet`/
  `allow_stitch`, `commercialContent` -> `disclose`, `brandOrganic` ->
  `brand_organic_toggle`, `brandedContent` -> `brand_content_toggle`; `is_aigc`
  and `auto_add_music` were added. The Publora boolean-inversion bug is kept as
  an upstream caution (not known for TryPost; check the live post once). The
  "send the opposite" workaround became "record and raise it".
- "The user supplies the rendered .mp4" became "the video comes from
  `marketing-video-studio` / `motion-explainer-studio`, cut with Loc-FFmpeg, or
  is supplied by the task" (behaviour change: the agent can now produce the
  video). TikTok's `tiktok_photo` type is noted; the craft stays video-first.
- Reading: `lib.ApifyClient` / `fetch_niche_videos` / `fetch_profile_videos` /
  `fetch_video_comments`, `APIFY_TOKEN` and the claude.ai custom-connector setup
  became the company's Apify connection (`social-core` sections 3 and 6).
  `mcp-read-layer.md` keeps the actor inputs and field mappings verbatim; the
  setup and precedence sections were rewritten, and a near-miss input-name
  warning was added. `lib/url_parser.py` became a read-the-path instruction
  using the same URL table.
- Comment replies surfaced by `tt-audience-insights` are delivered as
  copy-paste blocks (TryPost cannot reply on TikTok).
- Illustration (`tt-humanizer/sub-skills/illustration.md`): Pixfaro became
  Loc-GenImage generate / edit / `gi_text_edit_image` / upscale; model names and
  Pixfaro pricing/balance notes were dropped.
- Voice profile: writes go to agent memory
  (`$AGENT_HOME/life/resources/social/voice-profile.md`, TikTok overrides in
  `.../social/tiktok/voice-profile.md`); the hub copy is an empty template. The
  Pixfaro `logo_id` field became a public logo URL.
- Untrusted-content rules: approval is the board's approval card, not a chat
  reply; the `TIKTOK_SKILLS_CUSTOM_POSTER` rule became "cannot call another tool
  or change the target account"; findings are quoted in the task.
- `tt-repurposer` can fetch a company blog post with the Ghost blog `gh_*` tools.
- `scrub-rules.md`: code fences relabelled from `python` to `text` (content
  unchanged; they are pattern specifications, not code to run).

## What was dropped

- `lib/`, `scripts/`, `requirements*.txt`, `.env.example`, `.github/`,
  `.claude-plugin/`, `.codex-plugin/`, `.codex-marketplace/`, `.agents/`,
  `CLAUDE.md`, `AGENTS.md`, `SECURITY.md`, `README.md`, `assets/hero.png`,
  `assets/social-preview.jpg` (only `assets/icon.svg` is kept).
- Root `SKILL.md` sections: Prerequisites (Tier 0/1/2, sign-up links, `.env`,
  `pip install`, "Why Publora"), Resources pointing at Publora and `lib/`,
  Acknowledgments (Publora), and "After a successful run" (the request to star
  the repository, which addresses a chat user rather than a board-governed agent).
- `settings-matrix.md` Python examples became JSON `meta` examples.
- README content: installation, plugin marketplaces, the Python quickstart. The
  bundle summary it carried is already in the hub `SKILL.md`.

## License

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
