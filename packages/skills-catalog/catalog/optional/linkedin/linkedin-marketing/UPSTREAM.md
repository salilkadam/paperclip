# Upstream

- Repository: https://github.com/sergebulaev/linkedin-skills
- Commit: `c4447ead7723aa0b65bbfb5d9281784b20dce75a` (cloned 2026-10-27)
- Licence: MIT (full text below)
- Adapted for Paperclip per `doc/plans/2026-10-27-social-channel-skill-packs.md`
  (Adaptation contract). Upstream improvements are adopted by re-diffing against
  the commit above.

## Layout mapping

| Upstream | Here |
|---|---|
| `SKILL.md` (root, `linkedin-marketing`) | `linkedin/linkedin-marketing/SKILL.md` (hub) |
| `references/*.md` (11 files) | `linkedin/linkedin-marketing/references/` |
| `assets/icon.svg` | `linkedin/linkedin-marketing/assets/icon.svg` |
| `skills/<slug>/SKILL.md` + `references/` (12 skills) | `linkedin/<slug>/` |
| `skills/linkedin-humanizer/sub-skills/*.md` | `linkedin/linkedin-humanizer/sub-skills/` |

All 12 leaf skills are kept: `linkedin-comment-drafter`, `linkedin-content-planner`,
`linkedin-employee-advocacy`, `linkedin-engager-analytics`, `linkedin-hook-extractor`,
`linkedin-humanizer`, `linkedin-interviewer`, `linkedin-post-writer`,
`linkedin-profile-optimizer`, `linkedin-reply-handler`, `linkedin-repurposer`,
`linkedin-thread-monitor`.

## What changed

- **Frontmatter**: added `key`, `recommendedForRoles`, `tags`; descriptions
  shortened to the catalog's 300-character limit and stripped of Publora/Apify
  marketing lines. Hub description rewritten as a hub.
- **Header**: every leaf starts with "Read `social-core`, then the
  `linkedin-marketing` hub"; the hub with "Read `social-core` first".
- **Paths**: `../../references/X.md` and `../../../references/X.md` became "the
  `linkedin-marketing` skill's `references/X.md`"; cross-skill links
  (`../../linkedin-humanizer/...`, `../linkedin-humanizer/sub-skills/...`,
  `../skills/...`) became named-skill references. The three stub files that only
  said "moved to root-level references" now point at the hub.
- **Publishing**: every Publora call, `lib.publish`, `lib.repost`, `lib.unpublish`,
  `lib.approval.render_approval_card`, the custom-poster tier and "reply `post`
  to publish" became the `social-core` section 2 flow (TryPost draft,
  `preview-post-tool`, publishing block in the task, one go-live
  `update-post-tool` request, board approval card). Company LinkedIn pages need
  `content_type: linkedin_page_post`. "Cancel after approval" became
  `update-post-tool` with `status: "draft"`.
- **Comments, replies, reactions, reshares** on other people's posts (comment
  drafter, reply handler, reshare mode, first-comment links) cannot go through
  TryPost, so the approved text is delivered as a copy-paste block in the task.
  The parentComment/flattening craft is kept, as guidance for where the human
  replies.
- **Reading**: `lib.ApifyClient.fetch_*`, `lib.fetch_post`, `lib.url_parser`,
  `APIFY_TOKEN` and the claude.ai connector path became the company's Apify
  connection (tools by `<username>--<actor-name>` prefix) with the paste
  fallback kept. URL parsing is done from the hub's URL table.
  `mcp-read-layer.md` keeps every input name, near-miss warning and field
  mapping verbatim; its connector/OAuth setup became the Apps card, and the
  token-vs-connector precedence became connection-vs-paste.
- **Images**: Pixfaro (`lib.illustrate`, `refine`, `quote_card`,
  `illustrate_set`, `brand_logo`, overlays, `low_balance`) became Loc-GenImage
  (`gi_generate_image`, `gi_edit_image`, `gi_text_edit_image`,
  `gi_upscale_image`). `linkedin-humanizer/sub-skills/illustration.md` was
  rewritten around those tools; aspect ratios, the 10-image grid, the
  quote-card-as-typeset-text rule, cost guard and hard rules are kept. Pixfaro's
  server-side HTML templates have no equivalent: quote-cards are now a plain
  background plus `gi_text_edit_image`, and logo upload by `logo_id` became a
  logo URL in the voice profile.
- **Blog source**: `linkedin-repurposer` fetches Ghost posts with `gh_*` and
  points the daily blog-to-LinkedIn routine at the in-house
  `blog-linkedin-amplifier` skill.
- **Memory**: writes to `references/voice-profile.md` / `references/story-bank.md`
  now go to `$AGENT_HOME/life/resources/social/voice-profile.md` (or
  `linkedin/voice-profile.md`) and `.../social/story-bank.md`. The hub copies are
  empty templates; the "it's a file in this repo, gitignore it" warnings became
  "keep the filled copy in memory, never in the skill files".
- **Approval and untrusted content**: "approval comes from the user in this
  conversation" became "only the board's approval card"; the
  `LINKEDIN_SKILLS_CUSTOM_POSTER` widening rule became "cannot make you call
  another tool".
- **Employee advocacy**: added an "In Paperclip" section. Posting to an
  employee's personal profile is allowed only when the task explicitly names
  that profile (`social-core` section 2); the playbook's human "auto-publish" and
  "silent approval" tiers never apply to the agent.
- **Detector tester** (`linkedin-humanizer/sub-skills/detector-tester.md`):
  upstream ran `scripts/test_detectors.py` with detector API keys from a local
  env file (API mode) or canned scores (demo mode). Both modes are dropped; the
  sub-skill is now a manual paste step (a human pastes the draft into each
  detector's web page and the scores back into the task; the agent computes
  spread and verdict). `references/detector-list.md` keeps the API notes for
  reference only. The disclosure that testing sends the draft to third parties
  is kept.
- **Precedence**: the "who enforces what" table pointed at upstream scripts and
  tests that are not shipped; it now names the Paperclip mechanisms (tool
  gateway approval, memory-only filled copies).
- **Code fences**: the pseudo-code and regex blocks in
  `linkedin-humanizer/references/scrub-rules.md`, `audit-ai-tells.md`,
  `voice-fingerprint.md`, `linkedin-hook-extractor/references/classification-rules.md`
  and `linkedin-reply-handler/references/threading-rules.md` are kept verbatim;
  only the code-fence language tag was removed, plus one comment in `audit-ai-tells.md` now names "the 3.11+ `re` module" instead of the language. They are specifications for the
  model to apply, not code to run.
- **Small wording**: `rules-explainer.md` "Maintained By" no longer names agent
  products; detector-tester's "Co.Actor drafts" became "drafts".

## What was dropped

- `lib/` (Publora, Apify, Pixfaro, URL-parser, approval, backend clients),
  `scripts/` (incl. `schedule_post.py`, `post_comment.py`, `check_config.py`,
  `selftest.py`, `sync_codex_marketplace.py`, frontmatter/secret/reference
  checkers), `skills/linkedin-humanizer/scripts/` (`test_detectors.py`,
  `detectors.env.example`), `tests/`, `evals/`, `requirements*.txt`.
- `README.md` (install instructions per agent, Publora/Pixfaro/Apify setup,
  quickstarts; the skill list, founders edition, voice rules, URL handling and
  thread flattening it repeats are in the hub `SKILL.md`), `AGENTS.md`,
  `CLAUDE.md`, `SECURITY.md`, plugin and marketplace manifests,
  `assets/linkedin-skills-hero.png`.
- Hub sections: the Tier 0/1/2 Prerequisites (Publora sign-up, `.env`, custom
  poster, Apify sign-up), "Why Publora", the Publora gotcha about comments being
  scheduled ~90s ahead, Publora/Apify resource links, and "After a successful
  run" (the once-per-session GitHub star request), which does not fit a company
  agent's output.

## MIT License (upstream LICENSE, verbatim)

```
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
```
