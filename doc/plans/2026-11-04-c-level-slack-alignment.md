# C-level Slack alignment (Option B): one board voice, @mention-only peers

Owner decision 2026-11-04, after a live audit of both orgs (Bionic AI Solutions,
Reliora Inc): **Option B — the CEO bot is the sole board-channel voice; every
other C-level Slack bot is @mention-only; DMs stay open for everyone.**

## Why

- With `requireAtMention=false`, every top-level human post in an enabled
  channel wakes the bound agent (`chat-channels/inbound/admission.ts`). Reliora
  had CMO/CLO/CIO bots in (or attachable to) `#reliora-board` with
  `mention=false`: a single board post would double-wake four C-level agents.
- Board-channel **trust** requires `mentionNotRequired` (`chat-channels.ts`
  trust rules), so exactly one bot per channel can be the trusted board voice:
  the CEO's. The DB enforces one `boardTrusted` resource per
  (company, channel) and one `boardCards` per company
  (`packages/db/src/schema/chat_channels.ts`).
- Two-way board access is preserved: a linked owner/admin top-level post in a
  trusted channel creates work for the CEO agent (board trust, 2026-10-31
  plan), and thread replies to a bot's card are admitted without a mention
  (`existingConversation !== null`). Peer C-levels are reached with
  `@CMO @CLO @CIO` in the channel, or any time by DM (`isDM` bypasses the
  mention gate).

## What was applied live (2026-11-04, read-back verified)

`PATCH /api/chat-endpoints/:id {"requireAtMention": true}` on the three Reliora
non-CEO C-level endpoints — `cmoreliora`, `clegalreliora`, `cioreliora` — each
proven by a subsequent `GET`. Final matrix:

| Bot | requireAtMention | policy | board channel | trust/cards |
|---|---|---|---|---|
| ceobionic | false | agent | #bionic-board enabled | trusted + cards |
| cmobionic | true | restricted | #bionic-board enabled | — |
| ceoreliora | false | agent | #reliora-board enabled | trusted + cards |
| cmoreliora | true (flipped) | restricted | #reliora-board enabled | — |
| clegalreliora | true (flipped) | restricted | #reliora-board enabled | — |
| cioreliora | true (flipped) | restricted | not in channel yet | — |

DMs remained open everywhere (`allowDirectMessages=true` unchanged).

## Template for new companies

`deploy/scripts/setup-c-level-slack-alignment.sh` (dry-run by default check
with `--dry-run`; `--company-id` to target one org) walks **every** active
company each run and is idempotent:

1. classifies C-level agents (same classifier as
   `setup-agent-job-function-access.sh`: role `ceo|cto|cmo|cfo`, title
   `^Chief .*Officer$`, or name `^C[A-Z]O$`);
2. locates the company's board channel via the `boardCards` resource;
3. asserts (never edits) the CEO endpoint keeps `mention=false`,
   `policy=agent`, and the channel trusted+cards —
   `setup-board-channel-trust.sh` owns that;
4. enforces `requireAtMention=true` on non-CEO C-level endpoints, with GET
   read-back proof;
5. prints outstanding **human** steps, which no API can replace.

Run it after onboarding any new company's C-level bots.

## Known gaps / human steps (as of 2026-11-04)

- **Reliora CIO has no channel at all**: a Slack bot cannot self-join
  (`packages/shared/src/slack-tools.ts` — the invite tool cannot invite this
  bot; the app manifest lacks join scopes; there is no server-side
  `conversations.invite` path). A human must run
  `/invite @cioreliora #reliora-board` in Slack; the channel auto-enables on
  join (`inbound/authorization.ts` `ensureResource`), and the policy is
  already flipped so it is mention-gated the moment it lands. Re-run the
  script to prove it.
- **Bionic CIO/CLO/COO and Reliora COO have no Slack bot**: each endpoint is a
  separate Slack app; a human must create the app(s), then
  `POST /api/chat-endpoints` (`provider=slack`, `assignedAgentId`,
  `slackSetupMethod=manual|automatic` — see
  `doc/connections/CONNECTOR-PLAYBOOK.md`), then invite. Option A (more
  trusted voices) was explicitly not chosen; if wanted later, it needs a
  product change to the one-trusted-bot-per-channel constraint.
- The two draft Microsoft Teams endpoints (one per org, → CMO) were not
  touched.

## Risks

- Over-gating: a non-CEO C bot in a channel with `mention=true` ignores
  unaddressed posts — intended. Recovery is `PATCH {"requireAtMention": false}`.
- The script never PATCHes CEO endpoints (it only warns), so board trust cannot
  be broken by re-runs; conversely, a mis-classified CEO (no `role=ceo`)
  downgrades the assertion to the trust script's ownership.
- Verified: `bash -n` clean; live run applied exactly the three planned PATCHes;
  rerun changed nothing (idempotent); independent GET read-back matched the
  table above.
