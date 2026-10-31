# Board-channel trust: Slack parity for linked board members

Owner decision 2026-10-31: "anything I can do from the Paperclip chat interface should be allowed on the
channel set up in Paperclip." This plan records what blocks that today, the trust decision the owner approved,
the change, its tests, and the follow-ups. Status: approved for implementation; safety review pending.

## What blocks the board today (from the Slack connections' own logs, 2026-10-28..31)

| Refusal | Rule | Where |
|---|---|---|
| Channel message ignored ("did not address the agent or an active task thread"); edits ignored | A top-level message wakes an agent only if it @mentions the bot or replies in a thread the bot started; `requireAtMention` only removes the first check | `chat-channels.ts` admission: `activationAllowed = addressed \|\| existingConversation !== null`; `inbound/envelope.ts` `addressed` |
| "External identity must be linked to a Paperclip account" | Linked identity, per bot, must be an active non-viewer member | `inbound/authorization.ts` |
| Agents on a Slack-started task refused connection tools: `chat_provenance_foreign_message` / `chat_provenance_foreign_wake` (REL-3021 → REL-3248/3250/3252/3253) | A comment that arrived through a chat link is never a "direct board comment", so tasks derived from a chat conversation cannot inherit connection tools | `chat-channels/run-origin.ts` `isDirectBoardComment` (inbound link ⇒ false) |
| Retry and email sends refused on Slack-started tasks | `externalExecutionPolicy: restricted` on every endpoint; not editable in the product | `task-retry.ts`, `connection-intent-delivery.ts`, `email-channels.ts`; validator lacks the field |
| Slack rejected the bot's own card (`invalid_blocks`, header > 150 chars) | A publication path bypasses the 150-char heading cap | `publications/card-limits.ts`, `publications/transport.ts:129`, `chat-interaction-publications.ts`, `chat-publication-projection.ts` |

Parity today: **authorization** parity exists (a linked non-viewer member acts with their own permissions);
**trust** parity does not (a Slack message is treated as less than a UI comment); **reach** parity does not
(only Slack-started tasks are mirrored; approvals and tool-action cards are published to no external channel).

## Trust decision (owner, 2026-10-31)

> A message from a **linked Paperclip user with the owner or admin role**, posted in a **channel enabled on an
> active bot** (or a DM with that bot), is the board — equal to the same words typed in the Paperclip UI.

Explicitly rejected: `allowUnlinkedPeople` (anyone in the Slack workspace would command agents as a sponsored
guest under the owner's account). Guests, viewers and members below admin keep today's behaviour.

## Change 1 (this PR): `boardChannelTrust` on a chat endpoint

New column `chat_endpoints.board_channel_trust boolean not null default false` (migration 0376), exposed in the
endpoint API (`updateChatEndpointSchema`), the endpoint detail UI (toggle beside "Require @mention", with the
decision text above as its help), and `externalExecutionPolicy` made editable in the same places (enum
`restricted | agent`; default unchanged).

Definition — a delivery or comment is **board-trusted** when all hold:
1. the endpoint has `boardChannelTrust = true` and status `active`;
2. the sender's principal resolves (`ensurePrincipal`) to a linked user, `linkedDenied = false`;
3. that user's company membership is `active` with role `owner` or `admin` (viewer/member do not qualify);
4. the destination is an enabled endpoint resource (channel) or a direct message the endpoint allows.

Effects:
- **Admission** (`chat-channels.ts`): `activationAllowed = addressed || existingConversation !== null ||
  boardTrusted`. A board-trusted top-level message creates/wakes the task exactly as a mention would (same
  eventKind handling, thread subscription, binding). Computed after `ensurePrincipal`, never before.
- **Ignored notice**: when a Slack message is filtered for "not addressed" or "identity not linked", stage one
  ephemeral `safe_notice` to the sender (pattern: `slack/identity-links.ts` `stageConfirmation`), text:
  "Not picked up: start with @<bot> or reply in one of its threads. Linked board members in this channel don't
  need the @mention once Board-channel trust is on." / "...link your Slack to Paperclip first (mention the bot
  once and follow the private link)." Deduplicated per provider event; never for bots or message edits.
- **Provenance** (`run-origin.ts` `isDirectBoardComment`): an inbound-linked comment passes when its inbound
  `chatMessageLinks` row leads to a conversation whose endpoint is board-trusted (rule 1), the link's principal
  is linked to `run.responsibleUserId` (rule 2), that user is owner/admin (rule 3), and the conversation's
  resource is enabled or a DM (rule 4). Everything else in the function stays: `authorType = user`,
  `authorUserId = run.responsibleUserId`, same task, not deleted. Guest comments (no author) still never pass.
  Applies equally to the `wakeCommentId`/`wakeCommentIds` path, so the "live chat wake" variant
  (`chat_provenance_foreign_wake`, REL-3253) is covered.
- **No change** to `allowUnlinkedPeople`, to viewer handling, or to private-Slack-research boundaries.

Rollout: deploy, then set on the four board bots (`cmoreliora`, `ceoreliora`, `cmobionic`, `ceobionic`):
`boardChannelTrust = true`, `externalExecutionPolicy = agent`. Record the values in
`deploy/scripts/` (a `setup-board-channel-trust.sh` that asserts them, like the governance scripts).

## Tests (must fail on a planted defect)
- `run-origin.test.ts`: trusted inbound comment passes; fails when trust off / role member or viewer / principal
  linked to a different user / channel disabled / endpoint inactive / comment deleted; wake-comment variant.
- `chat-channels.integration.test.ts`: unaddressed Slack channel message from a linked admin with trust on →
  task created and bound; trust off → filtered with the ignored notice staged; unlinked sender → filtered with
  the link notice; viewer → filtered; DM path; `@mention` behaviour unchanged.
- Endpoint update: `boardChannelTrust` and `externalExecutionPolicy` round-trip; invalid policy rejected.
- Mutants to plant before merge: drop rule 3 (any linked member passes), drop rule 4 (disabled channel
  passes), notice staged for bots.

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
- Plan safety review (different model from the author): pending.
- Code review round 1 (different model from the implementer): pending.
