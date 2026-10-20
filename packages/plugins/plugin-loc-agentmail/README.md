# Loc-AgentMail connector

Email for Paperclip agents on mail infrastructure this instance owns: an agent
gets a real mailbox, reads it, and answers in the sender's thread. Nothing here
depends on a hosted mail-API vendor — the receive server, the sending provider
and the domain are all configuration.

Plugin id: `paperclip.loc-agentmail`

## Why it is shaped this way

Mail that arrives at an agent's address is only useful if the agent can answer
it the way a human colleague would: as a reply, in the same thread, from the
same address. Three rules carry that:

1. **Mailbox authority is configuration, never a tool argument.** An agent names
   a mailbox key; the connector checks that agent's company and assignment and
   forces `From:` to that mailbox's own verified address. Naming someone else's
   mailbox is refused, not silently honoured.
2. **Outbound goes straight to the sending provider.** While the receive server
   is authoritative for a domain, mail re-injected through it to a same-domain
   recipient resolves locally and bounces. So `send` never touches IMAP; it
   calls SES (`SendRawEmail`, SigV4) directly. Repointing the provider is a
   config change.
3. **The mailbox is the inbox.** A scheduled poll records the envelope plus a
   snippet and advances a per-mailbox UID watermark; bodies are read on demand.
   No object storage, no second copy of the mail to keep in sync, and a human
   reading the same mailbox sees exactly what the agent sees.

Inbound distribution (Google Groups split delivery, MX records, or anything
else that lands mail in the mailbox) is deliberately outside this connector —
it is a property of the domain, not of the plugin.

## Tools

| Tool | What it does |
| --- | --- |
| `send` | Send or reply as the assigned mailbox. `to`, `subject`, `text` (and optional `html`, `cc`, `inReplyTo`, `references`). |
| `list_inbox` | Newest messages with their `uid`, sender, subject and preview. `unreadOnly`, `limit`. |
| `read_message` | One message in full, including the `Message-ID` to reply to. `uid`, `maxChars`, `includeHtml`. |
| `mark_read` | Flag handled mail read (or unread). `uid`/`uids`, `read: false` to undo. |

Inbound mail is emitted to listeners as `plugin.paperclip.loc-agentmail.mail-received`
with envelope data and the snippet, so an issue-driven workflow can react to new
mail without polling.

## Configuration

Every network address is read again on every call, so moving mail servers or
changing providers needs no restart and no code change.

| Key | Meaning |
| --- | --- |
| `imap.host`, `imap.port`, `imap.tlsMode` | Receive server. `implicit` = implicit TLS (993). `none` is accepted only for a loopback test host — it sends passwords in the clear. |
| `imap.serverName`, `imap.caPem`, `imap.rejectUnauthorized` | TLS name override, private CA (self-signed in-cluster), and certificate verification. |
| `imap.mailbox` | Mailbox to poll and list. Default `INBOX`. |
| `send.transport` | `ses-api` or `disabled` (receive-only install). |
| `send.sesRegion`, `send.accessKeyId`, `send.secretAccessKey`, `send.configurationSet` | Sending provider. The key needs `ses:SendRawEmail` only. |
| `accounts[]` | `key` (what agents pass), `address`, `displayName`, `password`, `imapUser`, `fromAddress`, `replyTo`, `companyIds`, `agentIds`. |
| `poll.enabled`, `poll.maxMessagesPerAccount`, `poll.markSeen` | Poll switch, per-run batch cap, and whether polled mail is flagged read. |

`companyIds` decides which companies may use a mailbox; an empty `agentIds`
means every agent in those companies, and a populated list is an allowlist.
Bounded lists only — an agent cannot widen its own reach at runtime.

### Passwords and keys

Each `password`, `accessKeyId` and `secretAccessKey` is either a pasted value or
a Paperclip **saved secret**. Picking a saved secret stores a `secret_ref`
binding, so rotating the secret in the Secrets screen changes what the connector
uses on its next call, with no config edit and no redeploy. A bare secret-id
string typed into JSON is refused with instructions rather than being sent to
the provider as a literal. Resolution names the exact config path
(`accounts.0.password`) so the host can honour binding scoping, and resolved
values never enter state, entities, activity metadata, health details or logs.

## Trust boundaries

* `List-Id`, `List-Unsubscribe` and friends are stripped at parse time and are
  forbidden on outbound headers. Under split delivery they point at the
  distribution list, and honouring them would unsubscribe the mailbox itself.
* Outbound headers are built from an allowlist; `From`, `Sender`, `Return-Path`,
  `Message-ID` and `Date` cannot be overridden, extra headers must be `X-`
  prefixed, and any value containing a line break is rejected — so no tool
  argument can inject a header or end the SMTP transaction early.
* Bodies are base64 on the wire, so a leading-dot line cannot terminate the
  transaction.
* The IMAP client only ever uses `BODY.PEEK[]`; reading never changes a flag.
* Tool output labels message bodies as untrusted content, and the managed
  `agentmail-mailroom` skill (auto-reconciled per company) tells the agent to
  read before answering, reply in-thread, and escalate anything asking for
  credentials, payments or data export.

## Health and the config test

`onHealth` reports the configured endpoint, mailboxes, the last poll's counts and
failures, and probes the server with `CAPABILITY` — no credentials sent. A server
that refuses `LOGIN` in plaintext is reported as degraded with the reason, which
is the difference between "unreachable" and "misconfigured".

The settings screen's validation runs the same probe plus the whole config, so
one save lists every defect (`imap.host is required`, `accounts[0].key must be a
lowercase slug`, …) instead of one per attempt.

## Operating it

- **Repoint the mail server**: change `imap.host`/`port`/`tlsMode`/`caPem` and
  save. Polling and tools use the new host on their next call.
- **Repoint the sending provider**: change `send.sesRegion` and keys.
- **Add a domain**: create the mailbox, add an `accounts[]` entry with
  `companyIds`, and point the domain's distribution at it. Nothing else changes.
- **Drain a backlog**: the poll takes at most `maxMessagesPerAccount` per run and
  the watermark only advances over mail it actually recorded, so a mailbox that
  drifted behind catches up over several runs without skipping anything.
- A mailbox claimed by several companies is polled once, by the first company
  that lists it.

## Development

```sh
pnpm --filter @paperclipai/plugin-loc-agentmail typecheck
pnpm --filter @paperclipai/plugin-loc-agentmail test
pnpm --filter @paperclipai/plugin-loc-agentmail build
```

`build` emits the `dist/manifest.js` + `dist/worker.js` that
`BUNDLED_PLUGIN_CATALOG` key `loc-agentmail` installs from. To iterate against a
running instance, build then install the package directory through the plugin
registry — a reinstall picks up the new bundle without touching core.

The suites cover the address/header validators (injection cannot survive them),
MIME parsing including a Google-Groups-distributed message, SigV4 signing shape,
the SES wire format, the IMAP protocol parsers, and the worker against a
scripted IMAP server that it deliberately feeds in split chunks.
