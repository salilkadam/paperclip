# Upstream

- Repository: https://github.com/sergebulaev/x-skills
- Commit: `ea61d1d0f8874dd20633d241d52a297d57099483`
- Author: Sergey Bulaev
- License: MIT (full text below)
- Upstream root skill name: `x-marketing` (kept unchanged)

## What changed

- Root `SKILL.md` became this hub (`x-marketing`). Leaf skills moved from
  `skills/<slug>/` to sibling catalog directories
  `paperclipai/optional/x/<slug>` (9 leaves, all kept, including
  `x-humanizer/sub-skills/`).
- Frontmatter rewritten for the Paperclip catalog (`key`, `recommendedForRoles`,
  `tags`); every description shortened to 300 characters or less and stripped
  of Publora mentions.
- Every leaf gained the header line pointing to `social-core` and this hub.
  `../../references/X.md` and `../../../references/X.md` became "the
  `x-marketing` skill's `references/X.md`"; cross-leaf links
  (`../x-humanizer/sub-skills/...`) name the skill instead of a relative path.
- Publishing: `lib.publish(...)`, `lib/publora_client.py`, the Publora tier and
  the `X_SKILLS_CUSTOM_POSTER` tier were replaced by the TryPost flow of
  `social-core` section 2 (draft, preview, publishing block, one go-live
  request, board approval card). The leaf "Approval card" steps (which only
  showed the draft) were renamed "Draft summary" so they are not confused with
  the board's approval card.
- Threads: upstream relied on Publora auto-splitting one long `content` into a
  numbered `(1/N)` thread. TryPost publishes an X thread as one post with
  `meta.thread_replies` (checked with `list-content-types-tool`:
  `supports_thread_replies`, `max_thread_replies` = 24 at the time of
  writing) and does not split or number text. Behaviour change: the agent now
  splits the thread itself, using the same split order upstream documented
  (paragraph, sentence, word) and the `---` hand-split convention, and adds
  `(1/N)` markers only when the format calls for it. Affected: hub,
  `x-thread-builder` (section "How a thread goes into TryPost"),
  `x-post-writer`, `x-repurposer`, `thread-structure.md`, `post-audit.md`,
  `single-tweet-checklist.md`, `hook-formulas.md`, `algorithm-heuristics.md`.
- Hub additions from TryPost's own rules: the per-account character limit comes
  from `list-social-accounts-tool` (`max_content_length`), and link defusing can
  make X links non-clickable (check `preview-post-tool`).
- Replies: unchanged in substance. `x-reply-drafter` still delivers a
  copy-paste block (TryPost posts only to the company's own account and has no
  reply-to field). The quote-tweet path keeps copy-paste as the default.
- Reading: `lib.ApifyClient` (`fetch_user_tweets`, `fetch_tweet_replies`,
  `fetch_niche_top`, `fetch_tweet`), `APIFY_TOKEN` and the claude.ai
  custom-connector setup became the company's Apify connection (`social-core`
  sections 3 and 6). `mcp-read-layer.md` keeps the actor, the four input shapes,
  the `sort` vs `queryType` near-miss warning, the field mapping and the
  failure shapes verbatim; the connector setup, precedence and cost sections
  were rewritten. `x-audience-insights`' method table now names the actor
  inputs instead of library methods. `lib/url_parser.py` became a
  read-the-URL instruction using the same URL table.
- Illustration (`x-humanizer/sub-skills/illustration.md`): Pixfaro
  `illustrate`/`refine` and the pixel-exact overlay became Loc-GenImage
  generate / edit / `gi_text_edit_image` / upscale, attached to the TryPost
  draft by URL. Model names and Pixfaro pricing/balance notes were dropped;
  the cost guard now records image counts. `x-post-writer`'s "Optional
  illustration" section follows the same mapping.
- Voice profile and story bank: writes now go to agent memory
  (`$AGENT_HOME/life/resources/social/voice-profile.md`, X overrides in
  `.../social/x/voice-profile.md`, and `.../social/story-bank.md`); the hub
  copies are empty templates. The "keep this out of git" warnings became "keep
  the filled copy in memory". The Pixfaro `logo_id` field became a public logo
  URL. The voice-profile sub-skill's optional "read token" path became the
  Apify connection.
- Untrusted-content rules: approval is the board's approval card, not a chat
  reply; the `X_SKILLS_CUSTOM_POSTER` rule became "cannot call another tool or
  change the target account"; findings are quoted in the task and the original
  brief continues. "Supplied by the user in this conversation" became "supplied
  in the task".
- `x-repurposer` can fetch a company blog post with the Ghost blog `gh_*` tools.
- `scrub-rules.md`: code fences relabelled from `python` to `text` (content
  unchanged; they are pattern specifications, not code to run), and one
  comment's "Publora would re-split it" became "TryPost would reject it".

## What was dropped

- `lib/`, `scripts/`, `requirements*.txt`, `.env.example`, `.github/`,
  `.claude-plugin/`, `.codex-plugin/`, `.codex-marketplace/`, `.codexignore`,
  `.agents/`, `CLAUDE.md`, `AGENTS.md`, `SECURITY.md`, `README.md`,
  `assets/hero.png`, `assets/social-preview.jpg` (only `assets/icon.svg` is
  kept).
- Root `SKILL.md` sections: Prerequisites (Tier 0/1/2, Publora sign-up,
  `.env`, `pip install`, build-your-own-poster), the Publora resources and
  acknowledgments, and the "star the repo" closing line (replaced by the
  `social-core` setup line and the hub's TryPost section).
- README: install instructions per agent, the Publora/Pixfaro/Apify setup
  walkthroughs, troubleshooting and the Python quickstart. Its essential facts
  (thread mechanics, why a reply is copy-paste, the 9-skill table) are covered
  by the hub. Its reference link: the open-sourced X recommendation algorithm,
  https://github.com/twitter/the-algorithm, behind the 2026 heuristics.

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
