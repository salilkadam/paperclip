# Upstream

- Repository: https://github.com/sergebulaev/instagram-skills
- Commit: `6a124481d0ebe9b6d3ac1323ed2a2abc40c7e1d7`
- Author: Sergey Bulaev
- License: MIT (full text below)
- Upstream root skill name: `instagram-marketing` (kept unchanged)

## What changed

- Root `SKILL.md` became this hub (`instagram-marketing`). Leaf skills moved from
  `skills/<slug>/` to sibling catalog directories
  `paperclipai/optional/instagram/<slug>` (9 leaves, all kept).
- Frontmatter rewritten for the Paperclip catalog (`key`, `recommendedForRoles`,
  `tags`); every description shortened to 300 characters or less and stripped
  of Publora mentions.
- Every leaf gained the header line pointing to `social-core` and this hub.
  `../../references/X.md` and `../../../references/X.md` became "the
  `instagram-marketing` skill's `references/X.md`".
- Publishing: the Publora draft -> S3 upload -> schedule flow,
  `lib.publish(...)`, `lib/publora_client.py` and the custom-poster tier were
  replaced by the TryPost flow of `social-core` section 2 (draft with media,
  preview, publishing block, one go-live request, board approval card).
  `references/media-workflow.md` was rewritten around in-house media:
  Loc-GenImage for images and carousel slides (`gi_text_edit_image` for
  legible slide text), `marketing-video-studio` / `motion-explainer-studio`
  for Reels, Loc-FFmpeg for cuts, TryPost `media: [{ id }]` or public URL
  attach. Publora `platformSettings.instagram.videoType` / `coverUrl` became
  the TryPost content type (`instagram_feed`, `instagram_reel`, story) and the
  media item `meta.cover_offset_ms`, read from `list-content-types-tool`.
  Container rules and media limits kept as written.
- "The user supplies the media" became "the media is produced in-house or
  supplied by the task" (behaviour change: the agent now makes the image or
  Reel instead of waiting for a file).
- Reading: `lib.ApifyClient` / `fetch_niche_posts` / `fetch_profile`,
  `APIFY_TOKEN` and the claude.ai custom-connector setup became the company's
  Apify connection (`social-core` sections 3 and 6). `mcp-read-layer.md` keeps
  the actor inputs and field mappings verbatim; the setup and precedence
  sections were rewritten, and a near-miss input-name warning was added.
  `lib/url_parser.py` became a read-the-path instruction using the same URL table.
- Illustration (`ig-humanizer/sub-skills/illustration.md`): Pixfaro
  `illustrate`/`refine` and the pixel-exact overlay became Loc-GenImage
  generate / edit / `gi_text_edit_image` / upscale. Model names and Pixfaro
  pricing/balance notes were dropped; the cost guard now records image counts.
- Voice profile: writes to `references/voice-profile.md` now go to agent memory
  (`$AGENT_HOME/life/resources/social/voice-profile.md`, Instagram overrides in
  `.../social/instagram/voice-profile.md`); the hub copy is an empty template.
  The Pixfaro `logo_id` field became a public logo URL.
- Untrusted-content rules: approval is the board's approval card, not a chat
  reply; the `INSTAGRAM_SKILLS_CUSTOM_POSTER` rule became "cannot call another
  tool or change the target account"; findings are quoted in the task.
- `ig-repurposer` can fetch a company blog post with the Ghost blog `gh_*` tools.
- `scrub-rules.md`: code fences relabelled from `python` to `text` (content
  unchanged; they are pattern specifications, not code to run).
- `hashtag-strategy.md`: example branded tag `#builtwithpublora` became
  `#builtwithyourbrand`.

## What was dropped

- `lib/`, `scripts/`, `requirements*.txt`, `.env.example`, `.github/`,
  `.claude-plugin/`, `.codex-plugin/`, `.codex-marketplace/`, `.agents/`,
  `CLAUDE.md`, `AGENTS.md`, `SECURITY.md`, `README.md`, `assets/hero.png`,
  `assets/social-preview.jpg` (only `assets/icon.svg` is kept).
- Root `SKILL.md` sections: Prerequisites (Tier 0/1/2, sign-up links, `.env`,
  `pip install`), Resources pointing at Publora and `lib/`, Acknowledgments
  (Publora), and "After a successful run" (the request to star the repository,
  which addresses a chat user rather than a board-governed agent).
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
