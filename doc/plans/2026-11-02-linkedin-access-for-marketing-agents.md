# LinkedIn access for the CMO and content marketer: what broke, what changes

Date: 2026-11-02. Status: code shipped in this PR; two owner steps remain (section 4).

## 1. What the agents reported (Slack, 30 Oct – 1 Nov)

| When (PDT) | Who | What they said | What actually happened |
|---|---|---|---|
| 30 Oct 19:52 | `ceo-reliora` (DM) | "Apify is installed for the company but not enabled for my agent" — sent an access card | Correct and by design: Apify is bound to the CMO and the Content Marketer only (owner, 2026-10-27). |
| 31 Oct 00:16 | `ceo-reliora` (DM) | Delegated to the CMO, then the Content Marketer; "both were refused by a platform rule — tasks derived from our Slack chat are not allowed to use the LinkedIn/TryPost reading tools" | **The real cause.** The task was created from a Slack conversation. Slack-started tasks and the tasks derived from them carry chat provenance; the tool gateway refuses connection tools on them (`chat_provenance_foreign_message` / `chat_provenance_foreign_wake`, and `slack_private_source` on derived tasks). Nothing was wrong with Apify. |
| 31 Oct 23:22 | `cmo-reliora` (#reliora-board) | "My Apify tooling is unreachable this run" | Same rule: the run was a continuation started by "please continue" in the Slack channel. The same sweep from a Paperclip-created task had read five posts with Apify minutes earlier. |

The rule is intentional (`doc/plans/2026-09-22-slack-origin-tools.md`): a message that
arrived through a chat link is never a board instruction unless the board itself
is trusted. PR #71 (`doc/plans/2026-10-31-board-channel-trust.md`, deployed
2026-11-01 as helm rev 86) adds **board-channel trust**: a top-level, typed
message from a linked owner/admin in an **allowlisted private** Slack channel is
treated as a board instruction, and the restriction is lifted for that
conversation. Trust is **off** until the pre-enable gate in that plan is run.

Two preconditions found while checking this:

- **Both board channels are public.** Slack reports `#reliora-board`
  (`C0CC0J8NB5G`) and `#bionic-board` (`C0CC0J4LW8J`) as `public_channel`. The
  server refuses to trust a public channel (by design, from the safety review), so
  trust cannot be switched on until each is converted to a private channel in
  Slack (channel details → Settings → *Change to a private channel*; irreversible)
  or replaced by a private channel and reconnected.
- **The CMO's planned "read my profile's recent posts directly"** needs an Apify
  actor that lists a profile's posts. None was pinned; the 4 Nov sweep would have
  failed. This PR pins `apimaestro/linkedin-profile-posts` (no-cookies, $5 per
  1,000 results) and documents its mapping.

## 2. What this PR ships (no Paperclip server code changed)

| Change | Where |
|---|---|
| Apify card pins `apimaestro/linkedin-profile-posts`; governance allowlist and offline gate updated (16 actor tools) | `packages/shared/src/app-definitions/apify.json`, `self-serve-mcp-research.json`, `deploy/scripts/setup-apify-governance.sh`, `test-apify-governance-local.sh` |
| LinkedIn read layer documents the new actor ("A profile's recent posts") | `linkedin-marketing/references/mcp-read-layer.md`, hub actor table |
| **New skill `linkedin-personal-account`**: act as a board member's own LinkedIn account through the company's **Composio** connection (LinkedIn toolkit, OAuth with the member's login): member-only reads; posts, comments, replies and media **ask-first**; deletes never | `packages/skills-catalog/catalog/optional/linkedin/linkedin-personal-account/SKILL.md`; hub routing; `social-core` tool table; catalog manifest + test |
| Composio governance: block `LINKEDIN_DELETE_*` (priority 0), `require_approval` for every other non-read `LINKEDIN_*` slug (priority 1), probes for both | `deploy/scripts/setup-composio-governance.sh` |
| **New setup script `setup-linkedin-personal.sh`**: per company with a Composio connection — reports whether LinkedIn is connected, grants the CMO and content/growth marketer access to the Composio connection, syncs the three skills, runs the Composio governance, proves read=allowed / write=ask-first / delete=off as the CMO | `deploy/scripts/setup-linkedin-personal.sh` |

Why Composio and not a LinkedIn MCP connector: LinkedIn publishes no MCP server
and no OAuth-generic MCP endpoint, so Paperclip's generic MCP cards cannot reach
it. Composio's LinkedIn toolkit is the only connector in the catalog that acts
*as the member*; TryPost keeps scheduled publishing; Apify keeps public reads.

What the LinkedIn toolkit cannot do (so nobody plans on it): no feed, no search,
no notifications, no messaging. "Unanswered comments on our posts" stays:
list posts (TryPost published list or Apify `linkedin-profile-posts`) → read
comments per post (Apify) → draft → post the reply via
`LINKEDIN_CREATE_COMMENT_ON_POST` after approval.

## 3. After deploy (operator, with a board key)

1. Existing Apify connections keep the URL pinned at connection time. For each
   company's Apify connection, update the server URL to the card's new value and
   refresh its catalog (Apps → Apify connection → edit URL; or
   `deploy/scripts/refresh-connection.sh <connection-id>` after the URL change),
   then `deploy/scripts/setup-apify-governance.sh` (it fails if the catalog is not
   exactly the pinned set).
2. `deploy/scripts/setup-linkedin-personal.sh` for both companies. Until the owner
   connects LinkedIn in Composio it reports "LinkedIn app NOT connected" and still
   grants access, syncs skills and applies the governance.

## 4. Owner steps (cannot be done by an operator)

1. **Connect LinkedIn in Composio** for each company's Composio account with the
   personal LinkedIn login that the agents should act as (Composio dashboard →
   Connected accounts → LinkedIn; or approve an agent's `COMPOSIO_MANAGE_CONNECTIONS`
   card). Composio's shared OAuth app is rate-limited and cannot grant member
   posting together with organisation-admin reads; if both are needed, register an
   own LinkedIn OAuth app in Composio.
2. **Make the board channels private**, then run the board-channel trust rollout
   (`deploy/scripts/setup-board-channel-trust.sh` with `--owner-slack-user U080YEEAQ3G`,
   after the pre-enable gate's `--probe-delivery` checks in the plan). Until then,
   anything the agents must read or post for a Slack request has to be a task
   created in Paperclip — the CEO's own suggestion — or the agents will keep being
   refused on Slack-started tasks.

## 5. Not changed

- Apify stays bound to the CMO and the marketer, not the CEO (owner, 2026-10-27).
  The CEO delegates; the restriction that broke delegation is the chat provenance
  rule above, not Apify's binding.
- Replies on other people's posts remain copy-paste by default; posting them from
  the connected account is the extra, approved step.
