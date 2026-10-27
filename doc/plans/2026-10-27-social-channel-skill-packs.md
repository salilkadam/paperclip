# Social channel skill packs for the Content Marketer

Date: 2026-10-27. Owner decisions: 2026-10-27 (below).

## Goal

Make Sergey Bulaev's seven MIT-licensed social skill bundles available to every
company on the instance, grouped per channel, running on tools the companies
already have. Sources (pinned commits, cloned 2026-10-27):

| Channel | Repository | Commit | Leaf skills |
|---|---|---|---|
| LinkedIn | `sergebulaev/linkedin-skills` | see `UPSTREAM.md` in the hub | 12 |
| X | `sergebulaev/x-skills` | 〃 | 9 |
| Instagram | `sergebulaev/instagram-skills` | 〃 | 9 |
| YouTube | `sergebulaev/youtube-skills` | 〃 | 9 |
| Threads | `sergebulaev/threads-skills` | 〃 | 8 |
| TikTok | `sergebulaev/tiktok-skills` | 〃 | 8 |
| Facebook | `sergebulaev/facebook-skills` | 〃 | 8 |

## Owner decisions

1. Publishing uses TryPost only. The same rule applies to everything else: use
   the in-house tools already set up (Loc-GenImage for images, Ghost blog for
   blog material, marketing-video-studio / motion-explainer-studio / Loc-FFmpeg
   for video). Publora and Pixfaro are dropped.
2. (Pixfaro) answered by 1.
3. Each company provides its own keys. Keys live in Vault through the existing
   company secret provider tree (`t6-apps/bionic-org/paperclip`); a connection's
   credential is stored with `credentialSource: paperclip_vault`, so no new
   Vault paths or policies are needed.
4. Stick to Paperclip patterns so upgrades and company import/export keep
   working: catalog skills, AppDefinitions, team packages. No new install
   mechanism.

## Architecture

| Upstream piece | Paperclip shape | Why |
|---|---|---|
| Skills | Optional catalog skills, one category per channel: `catalog/optional/<channel>/<skill>/` | The catalog is instance-wide; each company installs what it uses. Category = channel group in the Store. |
| Shared `references/` (used by 50 of 59 leaf skills via `../../references/`) | A per-channel **hub** skill `<channel>-marketing` (the upstream root `SKILL.md`) that carries the shared references | Catalog skills install as independent directories; cross-skill `../../` paths would break. |
| Publora + `lib/approval.py` | TryPost through the tool gateway, ask-first approval cards | Upstream approval is a chat convention; Paperclip's is enforced. A plugin cannot run an approved action outside its run (see `plugin-ghost-blog` manifest), so publishing must stay an MCP connection. |
| `lib/apify_client.py`, `APIFY_TOKEN` | New **Apify** AppDefinition, API-key method, server URL pinned to the social actor list (`?tools=`) | Hosted MCP → AppDefinition per `CONNECTOR-PLAYBOOK.md` Phase 2. The actor list stops agents from running arbitrary paid actors. |
| `lib/youtube_client.py`, `YOUTUBE_API_KEY` | Same Apify connection: `streamers/youtube-scraper`, `streamers/youtube-comments-scraper` | One key per company instead of two; no YouTube MCP server exists. |
| Pixfaro | Loc-GenImage (`gi_*`) | In-house. |
| `references/voice-profile.md`, `story-bank.md` written in place | Agent memory: `$AGENT_HOME/life/resources/social/` (`para-memory-files`) | Installed skill files are shared, versioned copies. |
| Plugin manifests, Codex marketplace, `scripts/`, `tests/`, `evals/`, `requirements*.txt` | Not shipped | Keeps every skill `markdown_only`/`assets`; nothing executable. |
| "Content Marketer" | Team package `catalog/optional/content/social-content-studio` with a `content-marketer` agent requiring `social-core` and all hubs and leaves | Teams already install catalog skills by key and round-trip through company export. |

`social-core` (`catalog/optional/social/social-core`) is the shared Paperclip
layer: gateway access, TryPost governance, Apify read rules, untrusted content,
memory locations, per-company setup. Channel skills defer to it on tools,
publishing and approval.

## Adaptation contract (applies to every adapted skill)

1. **Keep the craft.** Hook formulas, algorithm notes, voice rules, templates,
   checklists and examples stay as written. Do not summarize them.
2. **Frontmatter** (catalog rules): `name` (upstream skill name), `description`
   40–300 characters with Publora/Python mentions removed, `key:
   paperclipai/optional/<channel>/<slug>`, `recommendedForRoles`, `tags`.
3. **Header.** Directly under the title: "Read `social-core`, then the
   `<channel>-marketing` hub, before using this skill."
4. **Paths.** `../../references/X.md` → "the `<channel>-marketing` skill's
   `references/X.md`". The skill's own `references/` stay with it.
5. **Publishing.** Every Publora call, `lib.*` publish helper, custom poster or
   "on approval, post" step → the social-core section 2 flow (TryPost draft,
   preview, publishing block, one go-live request, approval card).
6. **Reading.** Every `lib.fetch_*` / `ApifyClient` / `YouTubeClient` call → the
   Apify connection tool named in the hub's `mcp-read-layer.md`, with the paste
   fallback kept.
7. **Images** (Pixfaro) → Loc-GenImage; **video** → marketing-video-studio /
   motion-explainer-studio / Loc-FFmpeg; **blog source** → Ghost blog.
8. **Setup sections** (tiers, `.env`, sign-up links, `pip install`) → one line:
   "Setup: see `social-core` section 6."
9. **Memory.** Writes to `voice-profile.md` / `story-bank.md` → the memory paths
   in social-core section 5.
10. **Attribution.** Each hub has `UPSTREAM.md`: repository, commit, MIT licence
    text, and the list of changes. Leaf skills carry no licence boilerplate.
11. No `python`, `pip`, `.env`, `curl … | sh`, Publora or Pixfaro left anywhere
    except `UPSTREAM.md` (enforced by a catalog test).

## Delivery

Two independent PRs into `main`:

- **PR A — Apify connector**: AppDefinition, research-ledger entry, ingestion
  script method, permission review, brand icon and provenance, count tests.
- **PR B — skills and team**: this plan, `social-core`, 7 hubs + 63 leaves,
  `social-content-studio` team, catalog tests (expected keys, no-plumbing check).

Done = merged, deployed from `main`, and one Content Marketer run in a company
that drafts a LinkedIn post, raises the TryPost approval card naming the account,
and reads one post through Apify. Until then report the exact step reached.

## Open risks

- The Apify `?tools=` actor-filtered URL is documented but unverified live with
  a token here; verify `tools/list` when the first company connects.
- TryPost cannot reply to other people's posts on most networks; approved
  replies become copy-paste blocks (social-core section 2).
- TryPost's live content types (read 2026-10-27, catalog schema only, no calls)
  set these limits:
  - YouTube: only `youtube_short` (up to 180 s); no long-form, community-post
    or thumbnail type. Long-form uploads and community posts are handed to a
    human as an upload package or copy-paste block.
  - Threads: `supports_thread_replies: false`, so a multi-post chain publishes
    post 1 and hands posts 2..N over for manual replies.
  - X: thread replies are supported (up to 24, `meta.thread_replies`), but TryPost
    does not split text, so the skills split it.
- Pixfaro's server-side card templates have no Loc-GenImage equivalent;
  quote cards are a background plus `gi_text_edit_image`.
- Upstream improvements are adopted by re-diffing against the pinned commit in
  each `UPSTREAM.md`.

## Review record (2026-10-27)

Adversarial review by a different model (Claude Fable 5.1, thirteenth-man), one round, run on the uncommitted packs.

| # | Finding | Disposition |
|---|---|---|
| 1 | Apify spend bound rests on an unverified claim that `?tools=` removes `call-actor`/`search-actors`; no gateway policy covers Apify | **Fixed.** PR A adds `deploy/scripts/setup-apify-governance.sh`, which blocks the generic tools by name and proves the block with a `call-actor` test call on a nonexistent actor. The hubs no longer claim the tools are absent, and agents must report one if it appears. Live proof waits for the first company's Apify connection. |
| 2 | A leaf installed without its hub or `social-core` has unresolved references; `requires:` has no consumer | **Fixed by instruction.** Every leaf now says to stop and ask for the hub and `social-core` if either is missing. `requires:` lists runtime binaries, so it isn't used for this. The team package installs all 71. |
| 3 | The TryPost gate is per-company policy (`setup-trypost-governance.sh`), and the catalog test would miss a non-draft create or a publish call | **Fixed.** `social-core` section 6 makes the governance scripts part of setup, and section 2 makes a go-live call that succeeds without a card a reported governance gap. The catalog test now fails on any go-live tool name, and on `create-post(s)-tool` with no `"draft"` nearby. Planted defects fail it. It also caught a real `delete-post-tool` mention, now fixed. |
| 4 | Humanizer pseudo-CLI in ```bash fences | **Fixed:** relabelled as mode notation (`text`). |
| 5 | Recurring task installs with no trigger, but TEAM.md said "every week" | **Fixed:** TEAM.md says to set the schedule after install. Missing triggers are platform-wide behaviour, the same as `content-machine`. |
| 6 | `linkedin-reply-handler` keeps API wording ("400", "429") for copy-paste output | **Accepted risk.** Owner: content session. Trigger: the first reply-handler run that reports an API error that can't happen. Harmless meanwhile. |

The reviewer confirmed these were sound, not defects: every `create-post-tool` mention is a draft; no leaf names a credential; every documented actor input exists in the live schemas; `$AGENT_HOME` is real; no upstream craft file was dropped.

### PR A (Apify connector) — two rounds, Fable 5.1

| Round | Finding | Disposition |
|---|---|---|
| 1 | The governance probe called `call-actor`, which the pinned URL really removes (vendor `tools_loader.ts`), so the script could never succeed. The blocked names didn't exist, the four exposed helpers had no policy, and spend was unbounded. | **Fixed.** The script now (1) checks the synced catalog against an exact allowlist of the 15 pinned actor names (from vendor `actorNameToToolName`: 64-char cap, 4-hex sha256) plus the 4 helpers; (2) blocks `abort-actor-run`, `get-key-value-store-record` and the other 44 server tools; (3) rate-limits actor runs to 60 a day per company and connection. `social-core` handles `rate_limited`. |
| 1 | `get-actor-run` and `get-dataset-items` accept any id the token can reach | **Accepted risk.** Owner: each company's board. Trigger: any agent reading a dataset its own run didn't create. The card and review recommend a scoped token. |
| 2 | No false-success path, but the offline gate missed mutants: GENERIC omissions, `enabled:false`, block priority, `connectionId`, actor-hash typos. The probe didn't check the block reason. | **Fixed.** The gate now checks against an independent copy of Apify's 46 tool names, checks enabled/scope/priority, and re-derives the actor names from the card URL. 9/9 mutants are caught. The block policy runs first (priority 10), and the probe requires `deny_policy_block`. |
| 2 | The cap is proven only by reading it back, not by tripping it. Counters count attempts, in UTC windows. | **Accepted.** Tripping the cap would bill real runs. Trigger: the first `rate_limited` seen in production confirms it. |
