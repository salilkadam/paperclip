# Board-channel cards: every board decision reaches Slack

Owner, 2026-11-02: "Anything to be approved by board needs to bubble up to Slack." Today a card reaches Slack only
when its task started from a Slack message, and only into that thread; formal approvals never do; tool-action cards
arrive link-only. This implements the epic scoped in `2026-10-31-board-channel-trust.md` (stories 1 and 2; story 3,
retiring the agent-written board note, follows once Stage 1 is live; story 4, company-wide identity links, is out of
scope — the owner links once on the board bot).

## Stage 1: notify

**Setting.** `chat_endpoint_resources.board_cards boolean not null default false`, partial unique index on
`(company_id) where board_cards` — exactly one board destination per company. Settable only on a Slack channel
resource that is private and not externally shared (the same probe `board_trusted` uses). Card content is
board-confidential and Stage 2 buttons need a curated channel. Separate from `board_trusted` (inbound instructions).

**Representation.** Not `chat_conversations`/`chat_publications`: those require an issue (approvals may have none),
would bind the task to the board channel (mirroring all run progress, routing replies into the task) and trigger
per-conversation side effects. Instead an outbox in `chat_actions`, kind `board_card`, like `slack_board_message`:
- `payload.op` `post` | `settle`; `providerActionId` `board-card:{interaction|approval}:{id}:{rev}` (post) and
  `board-card-settle:{cardActionId}` (settle) — the unique index gives idempotency; `rev` increments when a subject
  is re-pended or resubmitted.
- Status `received → processing → published`, `cancelled`, `failed` (retryable). A stale `processing` post becomes
  `delivery_unknown` and is **never reposted** (a duplicate live card is worse than a missing one); a settle against it
  posts a button-less follow-up.
- Transport: the board endpoint's runtime, top-level post in the channel; edits by message ts. Cards go through the
  existing safe-card projection and provider limits. One endpoint at a time, honouring Slack `retry-after`.
- Thread replies under a card match no conversation, so they follow today's inbound rule and never reach a task.

**Who posts.** The endpoint owning the `board_cards` resource (Reliora: CEO bot, #reliora-board), whatever agent
raised the item. The card names the requesting agent. This is a server notice, not the agent speaking.

**What is posted.**
- Interactions `request_confirmation` / `ask_user_questions` created by an agent, pending. Not for Agent Chat issues,
  agent-addressed or user-created interactions, or when the task already lives in the board channel itself.
- Tool-action cards: title, requesting agent, `previewMarkdown` only (never the raw arguments).
- Formal approvals (all types): title, type, requester, summary only (never the raw payload). Tool-gateway approvals
  that also create an interaction get one card (keyed on the interaction).
- Private issues, or issues that read a private Slack channel: content-free card ("A task needs board attention" + link).
- Every card has "Open in Paperclip". When decided, expired, cancelled or superseded, the message is edited to the
  outcome with no buttons.

**Hooks.** Wrapper around `enqueueIssueInteractionChatPublications` (per-issue behaviour byte-identical); the two
tool-gateway connection-authorization inserts; `approvals` create/resolve/cancel/revision/resubmit; settle in
`enqueueTerminalIssueInteractionChatPublications` plus the two direct writers (`commitToolActionReview`,
`reflectToolActionInteractionLifecycle`). A bounded reconciliation sweep settles cards whose subject went terminal
and backfills pending approvals created by direct inserts (budgets).

## Stage 2: act

Approve/Reject (and single-select answers) as Slack buttons on the board card, resolved through the **same services
the UI uses**, only for a click by a Slack user **linked on the board endpoint** to a Paperclip user who **holds
owner or admin** in the company and can read the subject; checked again under lock in the resolving transaction.
Anyone else gets an ephemeral refusal and nothing changes. Tokens: `chat_actions` kind `board_card_decision`,
single-use, expiring at the earlier of 7 days and the subject's own expiry; settles expire sibling tokens.

| Item | Buttons | Why |
|---|---|---|
| Plain confirmation | Yes | Same predicate as Telegram native confirmations |
| Single-select question | Yes | Existing per-issue support |
| Tool action, read/write risk, no formal approval | Yes | Arguments are signed and hash-bound; never offer "remember" |
| Tool action that is destructive or behind a formal approval | No | Two-step governance and full argument view stay in Paperclip |
| Secret proposal, connection authorization, reject-with-reason | No | Needs the full UI (values, OAuth, a reason) |
| Approval `request_board_approval` | Yes | |
| Approval hire/budget/other | No | Rich payload the UI renders |

Races: if the UI decides first, the click gets "Already decided in Paperclip" and the card settles. Tool actions are
claimed durably, acknowledged to Slack, then executed through the UI's approve path.

## Setup

`deploy/scripts/setup-board-cards.sh`: set `boardCards` on the CEO bot's board-channel resource for Reliora (and
Bionic), assert the owner's Slack identity is linked on that endpoint with owner/admin role, assert one board
destination per company, dry-run lists the pending items the first sweep will post.

## Risks

Content leakage (credentials are pattern-redacted only, so cards carry previews, titles and summaries, never raw
payloads; private channel required); Slack rate limits (per-endpoint serial, retry-after, digest if volume grows);
bot optics (card names the requesting agent); per-bot identity links (setup asserts the owner is linked on the
board bot); missed funnels (reconciliation sweep).

## Plan safety review (Fable 5.1, 2026-11-02) and dispositions

Confirmed: the click authority (linked on the board endpoint + owner/admin, under lock) is strictly narrower than the
UI's "any non-viewer member"; tokens are per endpoint and single-use; Slack signatures are checked with a 300 s window.

| # | Finding | Disposition — the design above is amended as follows |
|---|---|---|
| B1 | The confirmation card body is `detailsMarkdown`, which for tool actions is the full argument JSON. | Board cards build their own body: tool actions use the server-built `previewMarkdown` only, never `detailsMarkdown`. Test plants a sentinel in the arguments and asserts it is absent from the Slack payload. |
| B2 | The gateway's formal `request_board_approval` (two-step gate) would get an Approve button via the backfill. | **All approvals are link-only in Slack** (notify, no buttons). Approvals with `payload.source = tool_gateway` get no separate card (the interaction card covers them). Test plants a destructive tool action. |
| B3 | "Can read the subject" has no UI predicate (accept/reject skip issue:read). | The click requires `issue:read` for the clicking user under the enforced privacy mode, no break-glass. Test: private issue, non-grantee admin is refused. |
| B4 | Creation and settlement hooks are incomplete (secret proposals, OAuth prompts, seven status writers, budgets). | **The sweep is the primary mechanism** for both posting and settling: every ~20 s it lists pending eligible interactions and approvals for companies with a board channel, posts the missing ones and settles cards whose subject is no longer pending. Hooks only wake the worker early. Maximum stale-button window = one sweep interval; a click on a stale card is refused by the resolver ("already decided"). |
| B5 | The default chat-action dispatcher re-dispatches stale `processing`, which would repost. | `board_card` has its own deadline/pending branch: stale `processing` becomes `delivery_unknown` and is never re-sent. |
| B6 | Channel privacy is checked only when set. | Re-probe `is_private`/`is_ext_shared`/`is_archived` before each post (cached ≤ 10 min); on failure post nothing and log an attention activity. |
| D1 | "Same services as the UI" over-claims: approval and interaction accept paths are route code. | Stage 2 buttons are limited to items whose UI path is a service call: plain confirmations (the Telegram predicate, which excludes plan-document reviews) via `issueThreadInteractionService`, single-select questions via `answerQuestions`, read/write tool actions via the gateway approve/decline path. Approvals stay in the UI. |
| D4 | Agent-authored text (prompts, options, approval titles) reaches the channel verbatim; non-Slack private sources are not detected. | Accepted, stated: the board channel's curation (private, not shared, re-probed) is the control; cards never include raw payloads or argument JSON. |
| Q2c | An @mention reply under a card creates a task bound to that thread. | Accepted, stated (normal Slack behaviour). |
