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
4. the raw Slack event is a plain human message: it carries a non-empty `client_msg_id` (set by Slack clients for
   typed messages), and no `bot_id`, `app_id`, `bot_profile` or `subtype`, and is not the bot itself (`author.isBot`
   alone is not enough — user-token integrations such as the claude.ai Slack connector, Composio or an agent's Slack
   tool post as the linked user). Fails closed when any field is missing. Caveat (code review round 1): Slack's docs do
   not say that user-token posts carry `app_id`/`bot_id`, and `chat.postMessage` accepts a caller-supplied
   `client_msg_id` (Paperclip's own `slack_post_message` sets one, `connectors/slack-writes.ts`, and reconciles by it),
   so `client_msg_id` excludes integrations that do not set it, not every integration. The post-deploy probe below
   checks the real integrations. The verdict is computed once at ingress and stored as
   `normalizedEvent.message.slackPlainHuman` for **every** Slack message delivery (with `slackPlainHumanTopLevel` for
   rules 4+5); recovery restores only the stored verdicts;
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
  user is currently an active owner/admin; the conversation is not a DM and its resource is `board_trusted`, enabled
  and available; the endpoint is active; **and the delivery's stored rule-4 verdict
  `normalized_event->'message'->'slackPlainHuman'` is the JSON boolean `true`** (the one input that cannot be re-read
  later, because the raw event is not kept). Without the last condition a user-token post made as the owner that
  @mentions the bot, or replies inside a trusted conversation, is admitted through the normal `addressed` /
  existing-conversation paths, becomes the owner's `user` comment, and would pass (code review round 1 blocker).
  `deliveryId` null, or a delivery stored before the verdict existed ⇒ fail closed. Everything else stays (`authorType = user`, `authorUserId = run.responsibleUserId`,
  same task, not deleted); guest comments (`authorType = system`) never pass. Applies to `wakeCommentId(s)` too.
  Note: `isDirectBoardComment` is shared with the GitHub guest check (`chat-github-tools.ts`); the change widens
  nothing there because GitHub resources are never `board_trusted` — test it.
- **Private-source exemption** (decision, see below): Slack reads/writes whose channel is `board_trusted` (and
  enabled and available, as in the provenance join) do not record a `slack_private_source` boundary. The board's own channel is the board's instructions, not research.
  Any other private channel keeps the boundary.
- **Execution policy sites** (`task-retry.ts`, `heartbeat/queue.ts` `retry_failed_run`, `connection-intent-delivery.ts`,
  `email-channels.ts`): with `externalExecutionPolicy = agent`, lift the restriction only when
  `chat_conversations.board_trusted` is true for the task's conversation; other conversations on the endpoint stay
  restricted. (Linked non-admin members and guests therefore gain nothing from the policy flip.) `agent` is refused
  (422) on any provider other than Slack and AgentMail, where it would lift nothing.
- **Observability**: a Slack delivery filtered as not addressed or not linked carries the two verdicts in its
  activity detail, static words only: "… (plain human post: yes|no; top-level: yes|no)". The read-only
  `POST /chat-endpoints/:id/board-trust/evaluate` accepts `{ resourceId, slackUserId, event }` (hypothetical event)
  or `{ deliveryId }` (a received delivery: stored verdicts plus current channel, link, role and mention state) and
  returns per-rule booleans (`channelTrusted`, `senderLinked`, `senderOwnerOrAdmin`, `plainHuman`,
  `plainHumanTopLevel`, `mentionNotRequired`).
- **No change** to `allowUnlinkedPeople` (stays false; setup script asserts it), viewer handling, or any
  non-trusted channel.

Rollout: deploy; then `deploy/scripts/setup-board-channel-trust.sh` sets and **asserts**, per company: the board
channel's `board_trusted` on exactly one endpoint (default: the CEO bot — `ceoreliora` in #reliora-board,
`ceobionic` in #bionic-board; the CMO bots stay @mention-only there), `externalExecutionPolicy = agent` on that
endpoint, `requireAtMention = false`, `allowUnlinkedPeople = false`; and probes refusals the way the governance
scripts probe policies: `bot_id`, `app_id`, no `client_msg_id` and a thread reply must each return `trusted=false`
with `rules.plainHumanTopLevel=false`, and a plain post by the owner's real Slack user id (`--owner-slack-user`,
required) must return `trusted=true`.
**Real-world probe (before trust is switched on):** deploy with trust off; the owner posts once in the board channel
through each user-token integration in use (claude.ai Slack connector, Composio, an agent's Slack tool); the
operator reads each delivery id and the "plain human post: …" detail from the activity feed and runs the script with
`--probe-delivery <id>` per post. Each must return `trusted=false` and `rules.plainHuman=false`; the script checks this
before any write and changes nothing otherwise. Also post once by hand (typed in Slack) and confirm the detail says
"plain human post: yes" — if real typed posts lack `client_msg_id`, genuine board messages would fail closed.

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
  staged for a bot or more than once a day; `agent` policy lifting restriction on a non-trusted conversation. Round 1 adds: provenance without the `slackPlainHuman` condition (an owner's `app_id` mention or `bot_id` thread reply passes); rule 4 without `client_msg_id`; the private-source exemption without enabled/available.

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
- Code review round 1 (different model from the implementer): seven required changes — rule 4 stored at ingress and
  required by provenance (blocker); `client_msg_id` as a positive signal; filtered-delivery verdict detail and
  evaluate-by-delivery with `--probe-delivery`; private-source exemption requires enabled/available; setup probes
  assert the refusing rule and a mandatory positive control; `agent` policy refused where it lifts nothing; tests
  for lock re-derivation on trust-off/link-revoked, the write-path exemption and DM provenance. All folded in above.
- Code review round 2 (different model from the implementer), dispositions:
  - Required, fixed: provenance test with the same Slack principal linked on the company's second bot, the link on
    the arrival endpoint revoked (mutant: drop the identity link's endpoint predicate); private-source exemption test
    with another company trusting a channel of the same id (see the mutant note below); the "not picked up" notice
    is gated on a human-ish check (rule 4 minus `client_msg_id`) so a person's post that Slack delivers without
    `client_msg_id` (e.g. "Schedule for later") is refused trust but told so, not dropped silently — trust itself
    still requires `client_msg_id`, the 24 h claim is unchanged, a recovered delivery whose stored verdict is not
    plain human gets no notice (its rebuilt raw event has no `ts`); setup script's dry-run summary corrected
    (`--probe-delivery` evaluations do run in `--dry-run`; synthetic probes do not).
  - Accepted (harmless observability): the verdict suffix "(plain human post: …; top-level: …)" now appears on every
    filtered Slack delivery's detail, not only in board-trusted channels. It carries two booleans and no content.
  - Accepted: an owner's *edit* of a board post arrives with a `subtype` and becomes a system-authored comment, so it
    can never be a provenance root. Only the original post carries the board's authority; re-post to amend.
  - Mutant note: `chat_endpoint_resources_company_endpoint_fk` ties a resource's company to its endpoint's, and the
    exemption query's endpoint join also filters `chat_endpoints.company_id`, so replacing only
    `chat_endpoint_resources.company_id = $company` with a tautology is an equivalent mutant (the cross-company test
    still passes). The test is proven by tautologising both company predicates (it then fails).
- Pre-enable gate (round 2; must hold before `board_trusted` is switched on for any channel): with trust still off,
  the operator records, through the `{deliveryId}` evaluate route (`--probe-delivery`, also in `--dry-run`):
  1. a real post made in the channel through a user-token integration (the claude.ai Slack connector) showing
     `plainHuman=false`;
  2. a real post typed by the owner in a Slack client showing `plainHuman=true`;
  3. a real "Schedule for later" post by the owner, recording whether it is trusted (`plainHuman` true or false;
     either is acceptable, the result is recorded here).
  If the connector post shows `plainHuman=true`, trust stays off everywhere and the result goes back to the owner
  as an open risk (rule 4 cannot tell that integration from the owner typing).
