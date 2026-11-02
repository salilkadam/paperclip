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

## Code review round 1 (Fable 5.1) and dispositions

Confirmed: no tool arguments, approval payloads or private-issue content reach Slack (three plants caught).

| # | Finding | Disposition |
|---|---|---|
| 1 | The worker never woke on first enable. | **Fixed:** setting `boardCards` wakes the board-card queue in the same transaction. |
| 2 | A failure before the send (channel probe, runtime) became a permanent `delivery_unknown`. | **Fixed:** preparation runs outside the send; its failures are retried with backoff and logged when they give up. Only the provider call can produce `delivery_unknown`, which is logged as activity. |
| 3 | An archived or missing endpoint's rows starved every company. | **Fixed:** those rows are cancelled with `board_endpoint_unavailable` and logged; paused/attention endpoints are not dispatched. |
| 4 | A cancelled or permanently failed post blocked a still-pending decision forever. | **Fixed:** such posts count as absent; the decision gets a new card (new rev). `delivery_unknown` stays the only never-repost state. |
| 5 | Settles skipped the channel re-probe. | **Fixed:** settles re-probe too; an unsafe channel cancels the settle and logs it. |
| 6 | Private-Slack-source tasks, approvals on private tasks, tasks already in the board channel. | **Fixed:** content-free cards for the first two; no board card when the task's conversation is the board channel. |
| 7 | Observability for 1–4. | **Fixed:** activity entries `chat.board_card_blocked`, `chat.board_card_failed`, `chat.board_card_delivery_unknown`. |
| D | Sweep cost grew with history; first enable could flood the channel. | **Fixed:** the sweep reads only open (unsettled) posts and the latest post of currently pending subjects; only decisions from the last 14 days are posted. |
| D | `enabled = false` still received cards. | **Fixed:** the board channel must also be enabled. |
| D | Agent text can carry Slack user/user-group mentions. | **Accepted** (pre-existing in thread cards; broadcast mentions are neutralised). |

## Found in production while delivering this: approved plugin actions could never run

The gateway refused to execute any board-approved plugin action ("Plugin actions cannot execute outside their
originating run"), so a require_approval policy on a plugin tool (the agreement send) could never send. Fixed in
the same release: an approved plugin action runs through the plugin dispatcher with the agent and run that requested
it and the signed arguments; a plugin error is a failed execution. Test: approve once runs once with the approved
arguments; approving again does not re-run; a plugin error fails the invocation; reverting the fix fails the test.

## Code review round 2 (Fable 5.1) and dispositions

Confirmed fixed by re-running the probes: sweep cost (5 queries regardless of history), archived-endpoint starvation,
first-enable wake, board-channel-task exclusion, settle re-probe. Gateway: an approved plugin action cannot run
without a valid human approval, twice, or for another agent/company/run.

| # | Finding | Disposition |
|---|---|---|
| 1 | The round-1 "re-post dead cards" fix re-staged every 20 s without bound (refused bot, public channel). | **Fixed:** a dead card is retried only after a 1-hour cool-down, only when the channel probe is ok again, never for a removed/archived bot, and at most 5 cards per decision. Tests: every send refused → ≤ 2 rows in 6 sweeps and ≤ 5 over 20 hours; public channel → 1 row over 6 sweeps; planted removal of the cool-down fails 2 tests. |
| 2 | A settle cancelled on a public channel (or exhausted) stayed dead, leaving the card live. | **Fixed:** dead settles are revived after the cool-down when the channel is safe again (≤ 5 revivals). Test: public → private → the card is edited; planted removal fails it. |
| D | Backfill filtered on created_at, missing re-pended OAuth prompts. | **Fixed:** greatest(created_at, updated_at). |
| D | `settled_after_send` guard was dead code. | **Fixed:** removed; a cancelled post was never shown, so it needs no settle. |
| D | A settle follow-up that failed ambiguously may be retried (duplicate "Approved:" follow-up). | **Accepted**, owner: board; trigger: a duplicate follow-up seen in the board channel. |
| D | Approved plugin actions pass the issue's current project (or none), not the run's original project. | **Accepted**, owner: board; pre-existing convention (`?? ""`); trigger: a plugin that scopes storage by project. |

Review rounds: 2 of 2 (safety tier cap); remaining fixes verified by the reviewer's probe scenarios and plants.

## Stage 2 as built

- Tokens: `chat_actions` kind `board_card_decision`, two per eligible card (accept/reject), issued in the same
  transaction as the post, bound to that post, expiring at the earlier of 7 days and the subject's own expiry, and
  expired when the card is settled.
- Eligible: plain confirmations (Telegram predicate: no reject-reason, secret proposal, connection authorization or
  plan-document review) and read/write tool actions without a formal approval, on non-private tasks. Questions,
  destructive or formal-approval tool actions, approvals and private tasks stay link-only (single-select questions
  are deferred: the per-issue path supports them, the board path does not yet).
- A click (Slack `block_actions`, signature-verified upstream) reaches `board-card-decisions.ts` only for a
  `board_card_decision` token on the same bot. It requires the token issued and unexpired, the card published with
  the clicked message id in the board channel, and, under lock in the resolving transaction: the Slack identity
  linked on this bot to the clicking user, an active owner/admin membership, the channel still the enabled board
  channel, and `issue:read` for that user. Plain confirmations resolve through `issueThreadInteractionService`
  (accept/reject, the UI's service) with an `interaction_wakeup` for the assignee; tool actions through the
  gateway's approve/decline (the UI route's calls). Refusals are ephemeral and logged
  (`chat.board_card_decision_refused`); decisions are logged (`chat.board_card_decided`).

## Stage 2 code review round 1 (Fable 5.1) and dispositions

Confirmed: nobody outside a linked owner/admin who can read the task can decide; tokens are company/endpoint
scoped and bound to the card message; UI-first races answer "already decided".

| # | Finding | Disposition |
|---|---|---|
| 1 | A losing concurrent click handed back the winner's claim; the claim condition had no test. | **Fixed:** only the call that made the claim may hand it back, and only if it never reached the gateway. Test: two truly simultaneous clicks reach the gateway once; the reviewer's unconditional-claim plant now fails it. |
| 2 | A gateway failure after the claim left the token `processing` forever, unlogged. | **Fixed:** the token becomes `failed` (or `processed` if the decision landed), `chat.board_card_decision_failed` is logged and the click is refused; settles expire `issued` and `failed` tokens. |
| 3 | Prompts addressed to one user had buttons; the service 403 escaped unlogged. | **Fixed:** addressed prompts get no buttons; service 403/404/409/422 become logged refusals. |
| 4 | The wake went to the pre-decision assignee; accepting can hand the task back to the creator agent. | **Fixed:** the wake target is re-read inside the resolving transaction. |
| 5 | Plain-confirmation decisions skipped the UI's `issue.thread_interaction_accepted/rejected` activity. | **Fixed:** the same activity is written (details.source = slack_board_card). |
| 6 | Reject woke the agent under `wake_assignee_on_accept`. | **Fixed.** |
| 7 | Refusals show the generic deny text; the card keeps its buttons up to one sweep after a decision. | **Accepted**, owner: board; trigger: confusion reported from the board channel. A click on a decided card is refused. |
| Q1 caveat | For tool actions the authority check runs in the claim transaction, not inside the gateway's commit. | **Accepted**, owner: board; the window is the gateway call; trigger: a role change racing a click. |

## Stage 2 code review round 2 (Fable 5.1) and dispositions

Confirmed by re-running the round-1 probes: concurrent clicks reach the gateway once (the plant now fails the
test), gateway failures are recorded and never stuck, accept-only rejects wake nobody, addressed prompts have no
buttons, the UI's accepted/rejected activity is written.

| # | Finding | Disposition |
|---|---|---|
| 1 | The wake was queued inside the service's hook, before the service hands a human-assigned task back to the creator agent, so nobody was woken. | **Fixed:** the wake is queued after the service returns, to the task's assignee at that point (as the UI wakes the continuation issue's assignee). Test: human-assigned task, Approve from Slack → one wake to the creator agent; the stale-assignee plant fails it. |
| 2 | After a gateway failure the sibling button stays live until the card settles. | **Accepted**, owner: board; the gateway serialises decisions; trigger: a second decision attempted after a failure. |
| 3 | The new `chat.board_card_*` activities have no UI label. | **Accepted** (wording only; the parity action is written). |

Review rounds: 2 of 2 (safety tier cap).
