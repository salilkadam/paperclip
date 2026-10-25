# Sandbox & AgentMail Capability Status — 2026-10-18

Companion status report to `2026-10-17-agent-sandboxes-email-memory.md` (the full
program plan). This document answers: *what can Paperclip agents do today, how do
they use it, and what remains.*

Program tracks:

| Track | Scope | Status |
|---|---|---|
| A — Sandboxes | Per-agent sandbox pods/containers on Brev/Crusoe `paperclip-linux`, reachable through a redirectable Paperclip connector | **Shipped, verified in production** |
| B — AgentMail | Send/receive email for agents on `agentmail.baisoln.com` / `agentmail.reliora.ai` (Stalwart + AWS SES) | **~70% — server and outbound relay live; DNS publish is the blocker** |
| C — Persistent memory | Letta + Graphiti retained (no Mem0/Honcho) | Deferred until B closes |

---

## Track A — Sandboxes: DONE

### What is live

- Plugin **`paperclip.ssh-docker-sandbox-provider`** is installed and `ready` in
  the production instance (`https://org.baisoln.com`, helm rev 48, image
  `docker4zerocool/bionic:12629946d` == `origin/main`).
- PR #38 (`feat(plugins): add ssh-docker sandbox provider`) squash-merged to
  `main`; ship record in plan §13.
- The provider leases a Docker container on the Brev host `paperclip-linux`
  (Crusoe `c1a.8x`, 31 GiB RAM, `ubuntu@216.86.169.255`) over SSH and runs agent
  work inside it. Environment probe passed: lease acquired, node v24.22.0.
- **Durability fixed:** the plugin bundle lives on the PVC at
  `/paperclip/bundles/ssh-docker` (an earlier `/tmp` install was wiped by a
  rollout). DB row `0375dec5-1c9c-4de7-bac5-f3678e1f3621` repointed; survived two
  subsequent rollouts.
- A heartbeat loop on the dev side keeps the Brev session/host alive so the
  connector is always on demand.

### How an agent uses it

- An agent is bound to the sandbox environment by setting
  `defaultEnvironmentId`. `WebEngineer` is bound today
  (`4123fb2c-ee70-4cc7-97bb-b0354ee66de3`) and the binding has survived two
  rollouts.
- Revert a binding any time: `PATCH /api/agents/:id {"defaultEnvironmentId":null}`.
- Each run gets a container (`paperclip-<envPrefix>-*`) on the shared node;
  agents effectively share the warm node, connection is the plugin's SSH session.

### Provider-redirectability (the design goal)

The connector encapsulates *host + SSH + Docker lease semantics* behind the
Paperclip environment/connector abstraction. Repointing to another
provider/node means changing the connector's host + credential config — no agent,
skill, or server code changes.

### Known caveats

- `reuseLease:true` can leak containers on failed runs; clean up on the host with
  `docker rm -f paperclip-4123fb2c-*`.
- Single shared node = single point of failure mitigated only by the Brev
  heartbeat; a Brev-host recreation would change its public IP and break both the
  sandbox SSH endpoint and (Track B) the `mail.baisoln.com` A record.

---

## Track B — AgentMail: IN PROGRESS (~70%)

### What is live

- **Stalwart 0.16.26** runs on `paperclip-linux`
  (`docker run --restart unless-stopped`, persistent `/opt/stalwart/{etc,db,data}`).
  Listeners up: 25 (SMTP), 465 (implicit-TLS submission), 993 (IMAPS), 443
  (HTTPS/JMAP + admin UI). Health: `curl -skI https://localhost` → 302.
- Domain provisioning complete server-side: `agentmail.baisoln.com`,
  `agentmail.reliora.ai` (plus `bionicaisolutions.com`) created in Stalwart; each
  generated a full DNS zone file (DKIM ed25519+rsa, SPF, DMARC p=reject,
  MTA-STS, TLSRPT). Domains were renamed from the earlier `agents.*` on
  2026-10-18 per operator decision; DKIM keys and the admin principal
  (`admin@agentmail.baisoln.com`) followed the rename with no stale config
  references.
- **SES outbound relay wired**: Stalwart `MtaRoute` `jke0hrjhktaa` relays to
  `email-smtp.us-east-1.amazonaws.com:465` with auth, selected by an
  `MtaOutboundStrategy` fallback route. This deliberately bypasses the older
  simplerelay path, which rewrote Message-IDs.
- Send capability has been proven end-to-end **from the server itself** (SES
  credentials are present and validated against verified identities
  `reliora.ai` / `salil.kadam@bionicaisolutions.com`).

### What is NOT done (and why)

1. **DNS is not published.** The zone files exist but nothing is live in
   Cloudflare — `agentmail.*` has no MX/DKIM/SPF/DMARC records, and
   `mail.baisoln.com` has no A record. **Blocker:** the instance's
   `cloudflare_token` has zero zone access (zones API returns `[]`).
   Records were handed to the operator for manual publish, or a scoped
   "Edit zone DNS" token for `baisoln.com` + `reliora.ai` unblocks automation.
2. **Agent mailbox accounts** not yet created (schema work done: Account
   `@type: User`, `credentials:[{"@type":"Password","secret":...}]`).
3. **E2E lab tests** pending after (1): outbound via SES to an external inbox,
   inbound to Stalwart on :25, agent-account send/receive via JMAP/IMAP.
4. **Inbound production path** after DNS: SES receiving rule (MX →
   `inbound-smtp.us-east-1.amazonaws.com`) → S3 → importer into Stalwart (SES has
   no direct HTTP POST action). Open verification item: Message-ID preservation
   through SES inbound; fallback plan is sub-addressing
   (`agent+c<token>@agentmail.<domain>`).

### DNS record set to publish

Both zone files (single-line Cloudflare-ready form, regenerated after the rename)
were pasted to the operator on 2026-10-18. Critical records: A
`mail → 216.86.169.255` (DNS-only, not proxied), MX `agentmail →
mail.baisoln.com`, two DKIM TXTs per domain, SPF, DMARC, MTA-STS + TLSRPT.
SRV/autoconfig records are optional.

### After MX publishes (SES inbound, then)

Note the plan flips for **receiving**: MX on `agentmail.*` must point at **SES
inbound**, not Stalwart, because the receiving flow needs SES verification +
S3 landing. The published zone MX (`mail.baisoln.com`) serves direct/MX delivery
tests first; SES receiving rule will introduce its own MX change + DKIM CNAMEs.

---

## Track C — Persistent Memory: DEFERRED (decision made)

- **Decision: keep Letta + Graphiti.** No Mem0/Honcho. Rationale in the plan doc.
- Start when Track B closes. Pattern will mirror Tracks A/B: OSS server on
  Brev/Crusoe, Paperclip connector with refreshable credentials, centrally
  published skills.

---

## Infra notes (both tracks)

- **A100 check (2026-10-18):** `psychiatric-maroon-sailfish` is **actively serving**
  the qwen-coder-next vLLM endpoint (live chat completions, 83% prefix-cache hits)
  — do not terminate. `comfyui-a100` runs a warm ComfyUI/Wan stack with sporadic
  jobs (~3k log lines/24h) — occasional-use, not idle. Neither is idle; cost
  reduction would require migrating those services first.
- Deploys: helm chart `./deploy/helm/bionic-org`, `domain=org.baisoln.com`; keep
  deployed image == `origin/main` (standing rule).
- The Brev board API key `sandbox-brev-proof-2026-10-17` remains active and should
  be revoked when all tracks close.

## Track B connector: `paperclip.loc-agentmail` (2026-10-19)

Built at `packages/plugins/plugin-loc-agentmail` and added to
`BUNDLED_PLUGIN_CATALOG` (key `loc-agentmail`). Four agent tools (`send`,
`list_inbox`, `read_message`, `mark_read`), a `poll-inbox` job (UID watermark +
`mail-received` event + company entity, no object storage), a managed
`agentmail-mailroom` skill, health reporting, and config-test that probes the
mail server with `CAPABILITY`.

Design points that came out of the Stalwart/SES findings:

- Outbound is SES `SendRawEmail` (SigV4 in-package, no AWS SDK) and never goes
  through Stalwart, so same-domain recipients work while Stalwart is
  authoritative for the domain.
- `List-*` headers are dropped on parse and forbidden outbound — under split
  delivery they belong to the Google Group, and honouring them would unsubscribe
  the agent mailbox.
- Mailbox authority is config (`companyIds`/`agentIds` allowlists); `From:` is
  always the assigned address.
- Mail host, SES region, ports, CA and `serverName` are all configuration; move
  the stack without a code change. Passwords/keys are paste-or-saved-secret, so
  rotation is picked up on the next call.
- `tlsMode: "none"` is accepted only for a loopback test host.

Verified: 97 package tests (address/header validators, MIME incl. a
Groups-distributed message, SigV4 canonical request, SES wire format, IMAP
protocol parsers, worker against a scripted IMAP server), package typecheck and
build, and `server` typecheck. Not yet done: the live E2E below (needs DNS +
mailboxes), so treat "works against the real Stalwart + SES" as unproven.

## Next actions (in order)

1. Operator publishes DNS (or grants scoped CF token) → verify with `dig`.
2. Create agent mailboxes + run the E2E lab (outbound via SES, inbound on :25).
3. SES receiving rule → S3 → Stalwart importer; verify Message-ID preservation.
4. Record Track-B completion in plan §14; revoke proof API key.
5. Kick off Track C (Letta + Graphiti connector + skills).
