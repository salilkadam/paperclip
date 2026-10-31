# Board-channel trust: Slack parity for linked board members

Owner decision 2026-10-31: "anything I can do from the Paperclip chat interface should be allowed on the
channel set up in Paperclip." This plan records what blocks that today, the trust decision the owner approved,
the change, its tests, and the follow-ups. Status: approved for implementation; safety review pending.

## What blocks the board today (from the Slack connections' own logs, 2026-10-28..31)

| Refusal | Rule | Where |
|---|---|---|
| Channel message ignored ("did not address the agent or an active task thread"); edits ignored | A top-level message wakes an agent only if it @mentions the bot or replies in a thread the bot started; `requireAtMention` (off on all four bots) would *add* a mention requirement even inside threads | `chat-channels.ts` admission: `activationAllowed = addressed \|\| existingConversation !== null`; `inbound/envelope.ts` `addressed` |
| "External identity must be linked to a Paperclip account" | Linked identity, per bot, must be an active non-viewer member | `inbound/authorization.ts` |
| Agents on a Slack-started task refused connection tools: `chat_provenance_foreign_message` / `chat_provenance_foreign_wake` (REL-3021 → REL-3248/3250/3252/3253) | A comment that arrived through a chat link is never a "direct board comment", so tasks derived from a chat conversation cannot inherit connection tools | `chat-channels/run-origin.ts` `isDirectBoardComment` (inbound link ⇒ false) |
| Retry, `retry_failed_run`, email sends and connection-intent restore refused on Slack-started tasks | `externalExecutionPolicy: restricted` on every endpoint; not editable in the product | `task-retry.ts`, `heartbeat/queue.ts`, `connection-intent-delivery.ts`, `email-channels.ts`; validator lacks the field |
| Derived tasks refused even when the origin is trusted: `slack_private_source` | The board channels are private; every Slack read or write in a task records a private-source boundary, and a chain holding one refuses tool inheritance | `connectors/slack-authority.ts`, `slack-writes.ts`, `connectors/slack.ts:168`, `run-origin.ts` private-source check |
| Slack rejected the bot's own card (`invalid_blocks`, header > 150 chars) | A publication path bypasses the 150-char heading cap | `publications/card-limits.ts`, `publications/transport.ts:129`, `chat-interaction-publications.ts`, `chat-publication-projection.ts` |

Parity today: **authorization** parity exists (a linked non-viewer member acts with their own permissions);
**trust** parity does not (a Slack message is treated as less than a UI comment); **reach** parity does not
(only Slack-started tasks are mirrored; approvals and tool-action cards are published to no external channel).

## Trust decision (owner, 2026-10-31)

> A message from a **linked Paperclip user with the owner or admin role**, posted in a **channel enabled on an
> active bot** (or a DM with that bot), is the board — equal to the same words typed in the Paperclip UI.

Explicitly rejected: `allowUnlinkedPeople` (anyone in the Slack workspace would command agents as a sponsored
guest under the owner's account). Guests, viewers and members below admin keep today's behaviour.

## Change 1 (this PR): board trust as an explicit per-channel allowlist

Schema (migration 0376):
- `chat_endpoint_resources.board_trusted boolean not null default false` — the allowlist. Settable only when the
  resource is a **private, non-shared** Slack channel (`is_private = true`, `is_ext_shared = false` from Slack's
  conversation info; refuse otherwise) and **no other endpoint of the company has `board_trusted` on the same
  external channel id** (one trusted bot per channel; enforce in the service and with a partial unique index on
  `(company_id, external_id) where board_trusted`).
- `chat_conversations.board_trusted boolean not null default false` — stamped at admission when the admitting
  message was board-trusted; read by the execution-policy sites below.
- `chat_endpoints.external_execution_policy` becomes editable (`restricted | agent`); validator rejects
  `restricted` for `agentmail` endpoints (DB check `chat_endpoints_email_policy_check` forces `agent` there).

Definition — a Slack message is **board-trusted** when all hold:
1. its resource (channel) has `board_trusted = true` on an endpoint with status `active`;
2. `ensurePrincipal` resolves the sender to a linked user with `linkedDenied = false`;
3. that user's company membership is `active` with role `owner` or `admin` (an extra role query: `ensurePrincipal`
   only excludes viewers);
4. the raw Slack event is a plain human message: no `bot_id`, no `app_id`, no `subtype`, not the bot itself
   (`author.isBot` alone is not enough — user-token integrations such as the claude.ai Slack connector or an agent's
   Slack tool post as the linked user);
5. it is a **top-level** channel message (`thread_ts` absent or equal to `ts`); thread replies keep today's rule
   (existing conversation), so the orphan-grace path and human-only threads are untouched;
6. `requireAtMention` is off on the endpoint (trust never overrides a mention requirement; the setup script asserts
   it is off on board bots).

Effects:
- **Admission** (`chat-channels.ts`): `activationAllowed = addressed || existingConversation !== null || boardTrusted`,
  computed after `ensurePrincipal` and the resource lookup. A board-trusted message creates and binds the task as
  a mention would (eventKind, thread subscription) and stamps `chat_conversations.board_trusted`.
- **Notices** (ephemeral `safe_notice`, pattern `slack/identity-links.ts`): (a) "not linked" only for **addressed**
  messages from an unlinked human; (b) "not picked up" only in **board-trusted channels**, for top-level human
  messages that were filtered as not addressed, **at most once per user per endpoint per 24 h**, static text.
  Never for bots, `subtype` events, edits, or the bot's own messages.
- **Provenance** (`run-origin.ts` `isDirectBoardComment`): an inbound-linked comment passes when, read **at check
  time** (never from a stored snapshot): `chat_message_links.deliveryId → chat_deliveries.principalId` on the
  conversation's own endpoint resolves to an identity link with status `linked` to `run.responsibleUserId`; that
  user is currently an active owner/admin; the conversation's resource is `board_trusted`; the endpoint is active.
  `deliveryId` null ⇒ fail closed. Everything else stays (`authorType = user`, `authorUserId = run.responsibleUserId`,
  same task, not deleted); guest comments (`authorType = system`) never pass. Applies to `wakeCommentId(s)` too.
  Note: `isDirectBoardComment` is shared with the GitHub guest check (`chat-github-tools.ts`); the change widens
  nothing there because GitHub resources are never `board_trusted` — test it.
- **Private-source exemption** (decision, see below): Slack reads/writes whose channel is `board_trusted` do not
  record a `slack_private_source` boundary. The board's own channel is the board's instructions, not research.
  Any other private channel keeps the boundary.
- **Execution policy sites** (`task-retry.ts`, `heartbeat/queue.ts` `retry_failed_run`, `connection-intent-delivery.ts`,
  `email-channels.ts`): with `externalExecutionPolicy = agent`, lift the restriction only when
  `chat_conversations.board_trusted` is true for the task's conversation; other conversations on the endpoint stay
  restricted. (Linked non-admin members and guests therefore gain nothing from the policy flip.)
- **No change** to `allowUnlinkedPeople` (stays false; setup script asserts it), viewer handling, or any
  non-trusted channel.

Rollout: deploy; then `deploy/scripts/setup-board-channel-trust.sh` sets and **asserts**, per company: the board
channel's `board_trusted` on exactly one endpoint (default: the CEO bot — `ceoreliora` in #reliora-board,
`ceobionic` in #bionic-board; the CMO bots stay @mention-only there), `externalExecutionPolicy = agent` on that
endpoint, `requireAtMention = false`, `allowUnlinkedPeople = false`; and probes a refusal (a bot-authored message
must not be trusted) the way the governance scripts probe policies.

### Decisions recorded from the safety review (owner to confirm; implementation proceeds on the recommendation)
- **Private-source exemption for board-trusted channels** — recommended yes; without it parity is not reached.
- **One trusted bot per board channel, default the CEO bot** — recommended; the CMO keeps @mention.
- **Accepted risks (stay open):** forwarded/quoted text becomes owner-authored instruction (same as pasting in the
  UI); takeover of the owner's Slack account equals board access (mitigation: Slack SSO/2FA; owner: Slack admin;
  trigger: any unexpected trusted task). Server and UI ship in one image (`updateChatEndpointSchema` is strict).

## Tests (must fail on a planted defect)
- `run-origin.test.ts`: trusted inbound comment passes; fails when trust off / role member or viewer / principal
  linked to a different user / channel disabled / endpoint inactive / comment deleted; wake-comment variant.
- `chat-channels.integration.test.ts`: unaddressed Slack channel message from a linked admin with trust on →
  task created and bound; trust off → filtered with the ignored notice staged; unlinked sender → filtered with
  the link notice; viewer → filtered; DM path; `@mention` behaviour unchanged.
- Endpoint update: `boardChannelTrust` and `externalExecutionPolicy` round-trip; invalid policy rejected.
- Mutants to plant before merge: drop rule 3 (any linked member passes); trust applied in a non-allowlisted
  channel; a post carrying `bot_id`/`app_id` trusted; a revoked link or demotion to member after admission still
  passing provenance; two endpoints trusted on one channel creating two tasks; a thread reply trusted; notice
  staged for a bot or more than once a day; `agent` policy lifting restriction on a non-trusted conversation.

## Change 2 (separate small PR): heading cap
Find the publication path whose first Slack block carries an uncapped heading (the two failures were
"waiting for input update" publications on 2026-10-30 00:30 and 01:17 UTC) and route it through
`fitCardToProviderLimits`/`headingFrom(…, 150)`. Test: a 200-char prompt yields a ≤150-char header with the
full text in the body.

## Epic (scoped, not started): mirror board-facing cards into the board channel
Goal: approve from Slack what the board approves in the UI. Stories, each needing a contract review:
1. Publish `request_board_approval` (formal approvals) and tool-action `request_confirmation` cards for tasks
   **not** started from Slack into the company's configured board channel, with Approve/Reject buttons wired
   to the same resolvers the UI uses, under the trust definition above.
2. A company setting naming the board channel (today it lives only in the `board-approval-notify` skill text).
3. Replace the agent-written "board note" with the mirrored card (keep the plain-language summary as the
   card body); retire the note step from `board-approval-notify`.
4. Company-wide identity links (link once, not once per bot).
Out of scope: binding arbitrary UI tasks to channels; mirroring every task thread.

## Review record
- Plan safety review (Opus, 2026-10-31): proceed with changes — nine required changes, all folded in above
  (per-channel allowlist; bot/app/subtype exclusion; top-level only; provenance reads current link and role via the
  delivery's principal; notices narrowed and rate-limited; policy scoped to trusted conversations, queue.ts added,
  agentmail validated; `requireAtMention` interplay stated; private-source row added and decided; mutants added).
  Confirmed sound: no confused deputy (`responsibleUserId` is the linked sender; the author check stays).
- Code review round 1 (different model from the implementer): pending.
