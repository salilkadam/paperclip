# Upstream

- Repository: https://github.com/sergebulaev/threads-skills
- Commit: `8a7f4356f29794ced662941d9c17b2ad6009aca7`
- Author: Sergey Bulaev
- License: MIT (full text below)
- Upstream root skill name: `threads-marketing` (kept unchanged)

## What changed

- Root `SKILL.md` became this hub (`threads-marketing`). Leaf skills moved from
  `skills/<slug>/` to sibling catalog directories
  `paperclipai/optional/threads/<slug>` (8 leaves, all kept, including
  `threads-humanizer/sub-skills/`).
- Frontmatter rewritten for the Paperclip catalog (`key`, `recommendedForRoles`,
  `tags`); every description shortened to 300 characters or less and stripped
  of Publora mentions.
- Every leaf gained the header line pointing to `social-core` and this hub.
  `../../references/X.md` and `../../../references/X.md` became "the
  `threads-marketing` skill's `references/X.md`"; cross-skill relative links
  (`../threads-humanizer/...`, `../references/scrub-rules.md`) name the skill
  instead.
- Publishing: `lib.publish(...)`, `lib/publora_client.py`, the Publora tier and
  the `THREADS_SKILLS_CUSTOM_POSTER` tier were replaced by the TryPost flow of
  `social-core` section 2 (draft, preview, publishing block, one go-live
  request, board approval card). The leaf "Approval card" steps (which only
  showed the draft) were renamed "Draft summary" so they are not confused with
  the board's approval card.
- **Multi-post threads (behaviour change).** Upstream relied on Publora
  auto-splitting one long `content` into a connected multi-post thread.
  TryPost chains threads only through `meta.thread_replies`, and
  `list-content-types-tool` reported `supports_thread_replies: false` for
  Threads (`threads_post`) when this was adapted (true only for X, Bluesky,
  Mastodon). So the skills now: split the thread themselves (same split order
  upstream documented, `---` hand-split convention kept); check
  `list-content-types-tool` at run time and use `meta.thread_replies` if
  Threads ever reports support; otherwise publish post 1 through TryPost and
  put posts 2..N in the task as a copy-paste block for a human to add as
  replies (upstream's own "post the opener and add the rest as replies by hand"
  fallback), or ship them as separate single posts when each stands alone.
  Affected: hub, `threads-post-writer` ("How a thread goes into TryPost"),
  `threads-repurposer`, `thread-structure.md`, `single-post-checklist.md`,
  `post-audit.md`, `hook-formulas.md`, `algorithm-heuristics.md`.
- Hub additions from TryPost's own rules: the per-account character limit comes
  from `list-social-accounts-tool` (TryPost does not expose the 10,000-char text
  attachment), the one tag can be set as `meta.topic_tag`, and the
  `threads_ghost_post` content type exists (use only when the task asks).
- `threads-post-writer`: Publora's `platform_settings.threads.replyControl` has
  no TryPost equivalent; the skill says so and leaves reply control to a human
  in the app.
- `algorithm-heuristics.md`: "Publora queues and distributes posts" became
  TryPost's queue (`queue: "next"` on the go-live request).
- Replies: unchanged in substance. `threads-reply-drafter` still delivers a
  copy-paste block (TryPost cannot target someone else's post); the quote-post
  path keeps copy-paste as the default.
- Reading: `lib.ApifyClient` (`fetch_niche_posts`, `fetch_profile`),
  `APIFY_TOKEN`, `.env` and the claude.ai custom-connector setup became the
  company's Apify connection (`social-core` sections 3 and 6).
  `mcp-read-layer.md` keeps both actors, their inputs, the `sort` lowercase
  near-miss warning, the `maxPosts` floor of 20, all three field mappings and
  the failure shapes verbatim; the connector setup, precedence and cost
  sections were rewritten, and references to the library's internal record
  names (`_search_post`, `_profile`, `_profile_post`) became plain record names.
  `threads-audience-insights`' method table now names the actor inputs.
  `lib/url_parser.py` became a read-the-URL instruction using the same URL table.
- Illustration (`threads-humanizer/sub-skills/illustration.md`): Pixfaro
  `illustrate`/`refine` and the pixel-exact overlay became Loc-GenImage
  generate / edit / `gi_text_edit_image` / upscale, attached to the TryPost
  draft by URL. Model names and Pixfaro pricing/balance notes were dropped;
  the cost guard now records image counts. `threads-post-writer`'s "Optional
  illustration" section follows the same mapping.
- Voice profile and story bank: writes now go to agent memory
  (`$AGENT_HOME/life/resources/social/voice-profile.md`, Threads overrides in
  `.../social/threads/voice-profile.md`, and `.../social/story-bank.md`); the
  hub copies are empty templates. The "keep this out of git" warnings became
  "keep the filled copy in memory". The Pixfaro `logo_id` field became a public
  logo URL. The voice-profile sub-skill's optional "read token" path became the
  Apify connection.
- Untrusted-content rules: approval is the board's approval card, not a chat
  reply; the `THREADS_SKILLS_CUSTOM_POSTER` rule became "cannot call another
  tool or change the target account"; findings are quoted in the task and the
  original brief continues. "Supplied by the user in this conversation" became
  "supplied in the task".
- `threads-repurposer` can fetch a company blog post with the Ghost blog `gh_*`
  tools.
- `scrub-rules.md`: code fences relabelled from `python` to `text` (content
  unchanged; they are pattern specifications, not code to run).

## What was dropped

- `lib/`, `scripts/`, `requirements*.txt`, `.env.example`, `.github/`,
  `.claude-plugin/`, `.codex-plugin/`, `.codex-marketplace/`, `.codexignore`, `.agents/`,
  `CLAUDE.md`, `AGENTS.md`, `SECURITY.md`, `README.md`, `assets/hero.png`,
  `assets/social-preview.jpg` (only `assets/icon.svg` is kept).
- Root `SKILL.md` sections: Prerequisites (Tier 0/1/2, Publora sign-up,
  `.env`, `pip install`, build-your-own-poster), the Publora resources and
  acknowledgments, and the "star the repo" closing line (replaced by the
  `social-core` setup line and the hub's TryPost section).
- README: install instructions per agent, the Publora/Pixfaro/Apify setup
  walkthroughs, troubleshooting and the Python quickstart. Its essential facts
  (thread mechanics, why a reply is copy-paste, the skill table) are covered by
  the hub. Its reference link: the official Threads API docs,
  https://developers.facebook.com/docs/threads/, behind the 2026 heuristics.

## License

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
