# Upstream

The Facebook skills in this category (`facebook-marketing` and the eight `fb-*`
skills) are adapted from Sergey Bulaev's Facebook Pages skills bundle.

- Repository: https://github.com/sergebulaev/facebook-skills
- Commit: `f3fb266c0b984cf5e9e9e3a6a57021373f3ced68`
- Licence: MIT (full text below)
- Upstream root skill name: `facebook-marketing` (kept)

## What changed

- **Layout.** The upstream root `SKILL.md` and root `references/` became this hub
  skill. Each `skills/<slug>/` became its own catalog skill
  (`paperclipai/optional/facebook/<slug>`) with its own `references/` (and, for
  `fb-humanizer`, its `sub-skills/`). Links to `../../references/X.md` (and
  `../../../references/X.md` from sub-skills and leaf references) now read "the
  `facebook-marketing` skill's `references/X.md`". `fb-post-writer`'s link to
  `../fb-humanizer/sub-skills/illustration.md` now names the `fb-humanizer` skill.
- **Frontmatter.** Catalog fields added (`key`, `recommendedForRoles`, `tags`);
  descriptions shortened to the catalog's 300-character limit and stripped of
  Publora mentions.
- **Header.** Every leaf (and sub-skill) starts with "Read `social-core`, then the
  `facebook-marketing` hub".
- **Publishing.** Publora (`lib.publish`, `create-post`, `FACEBOOK_PLATFORM_ID`)
  replaced by the TryPost draft -> preview -> publishing block -> one go-live
  request -> approval card flow in `social-core` section 2. The hub lists the
  Facebook content types TryPost reported on 2026-10-27 (`facebook_post`,
  `facebook_reel`, `facebook_story`). Comment replies stay copy-paste blocks
  (TryPost, like Publora, has no comment path); `fb-repurposer`'s "link in the
  first comment" also becomes a copy-paste line.
- **Reading.** `lib.ApifyClient` and `APIFY_TOKEN` replaced by the company's
  Apify connection. `references/mcp-read-layer.md` keeps the actor inputs, field
  mappings, near-miss input warnings and failure shapes verbatim; its connector
  setup (custom connector, OAuth, bearer token, filtered URL) is replaced by the
  Apps card, and the precedence list drops the token path. Upstream's negative
  caching becomes "record it in the task".
- **URL parsing.** `lib/url_parser.py` dropped; the accepted URL shapes and the
  fields it returned are in the hub's URL table.
- **Images.** Pixfaro (`lib.illustrate`, `refine`, model/cost guard) replaced by
  Loc-GenImage (`gi_generate_image`, `gi_edit_image`, `gi_text_edit_image` for
  legible overlay text, `gi_upscale_image`). Video comes from
  `marketing-video-studio` / `motion-explainer-studio`, Reels cut with
  Loc-FFmpeg. Blog sources for `fb-repurposer` can be fetched with the Ghost blog
  `gh_*` tools.
- **Memory.** The voice profile and story bank are written to
  `$AGENT_HOME/life/resources/social/voice-profile.md` (or
  `.../social/facebook/voice-profile.md`) and `.../social/story-bank.md`; the
  hub's `references/voice-profile.md` and `references/story-bank.md` stay empty
  templates. The "keep this out of git" warnings are replaced by "keep the filled
  copy in memory, never in the skill files".
- **Approval.** "The user replies post/yes" became the TryPost approval card; a
  chat or comment reply is never an approval.
- **Humanizer scrub rules.** The pseudocode blocks in
  `fb-humanizer/references/scrub-rules.md` are unchanged; only their fence label
  changed from `python` to `text` (they are rules for the model to apply, not code
  to run).
- **Untrusted content.** `references/untrusted-content.md` kept; the
  `FB_SKILLS_CUSTOM_POSTER` and `fetch_*` wording replaced with the Apify tools
  and the approval card.
- **Setup.** The Tier 0/1/2 prerequisites (sign-up links, `.env`, `pip install`,
  custom poster) replaced by one line pointing at `social-core` section 6.

## What was dropped

- `lib/` (Publora, Pixfaro, Apify and URL-parser clients, approval and backend
  helpers), `scripts/`, `requirements*.txt`, `.env.example`, `.github/`,
  `.claude-plugin/`, `.codex-plugin/`, `.codex-marketplace/` (a mirror of the
  same skills), `.agents/`, `CLAUDE.md`, `AGENTS.md`, `SECURITY.md`, `README.md`
  (its skill list and voice rules are in the hub), `assets/hero.png`,
  `assets/social-preview.jpg`. `assets/icon.svg` is kept.
- The hub's "Resources" and "Acknowledgments" sections (Publora links and the
  Python client; the story-bank and voice-profile pointers moved to the hub's
  "Memory" section) and the "After a successful run" request to star the
  upstream repository (not appropriate inside a company's agent runs).

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
