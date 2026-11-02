# Agent access follows job function

Date: 2026-11-02
Status: Owner's decision recorded. Not applied to production yet.

## Decision

- **C-level agents** delegate, review, strategize and answer to the board. They have full read access. They write only to Google Drive and to their own agent memory. Tactical work goes downstream.
- **Repo writes** are a technical job function. They go through the Sr. Engineer or the development team. This includes website changes.
- **Blogs, marketing material, decks and collateral** go to the Content Marketer or the agent the CMO designates.
- **Lower-level staff** have GitHub write and cluster access for code changes, and content access through their tools, as their function needs.

The reason: the Reliora CMO reported that it could not open website pull requests without GitHub access. That work is not the CMO's job function.

## How it is enforced

`deploy/scripts/setup-agent-job-function-access.sh` applies this per company.

| Surface | Control | Why |
|---|---|---|
| MCP tools | `allow` (priority 10) for Drive write tools, then `block` (priority 11) for all non-read risk levels, over the C-level agents | Policies are evaluated in priority order. A new write tool is blocked by default. |
| `git` and `gh` | The connection's install targets | The credential broker checks trust and grants, not tool policies. A tool block does not stop a real token. |
| Instructions | A marker-delimited section in each C-level `AGENTS.md` | The agent should delegate, not report a missing permission. |

### GitHub needs two connections per company

A company-wide managed connection gives every standard-trust agent a token. So:

- The **managed** connection (`github.code`) is installed for engineering agents only.
- A separate **non-managed** connection is installed for everyone else and is blocked to read-only. `git` and `gh` fail on it with "The managed GitHub identity is incomplete", which is the wanted result for those agents.

An agent must not have both installed. The non-managed grant has no GitHub account ID, so the resolver reports "More than one managed GitHub identity".

State found on 2026-11-02:

| Company | Connection | Kind | Installed for | Needed |
|---|---|---|---|---|
| Reliora | `77af219a` | Non-managed | Whole company | Add a managed connection for engineering, then narrow this one |
| Bionic | `9372637a` | Managed | Whole company | Add a read-only connection, then narrow this one. Until then Bionic's C-level agents can use `git` and `gh` |

## Known limits

- **Agent memory** is not covered by these policies. The script does not restrict or test it.
- **Risk levels come from the catalog.** The catalog classifies an unrecognized verb as `read`. The script also blocks tools whose names look mutating, and the proof fails if one stays open. A mutating tool with an innocent name is still open, so `--dry-run` lists every read-classified tool for a person to check.
- **`git` and `gh` depend on the read connection's credential.** An active agent or user grant with both `oauth.access_token` and GitHub metadata can export a token. The script refuses to narrow while one exists, or while the key cannot see the grants. Whether `gh` really fails for a C-level agent is not proven by the script: it needs a real run.
- **New agents:** the installs are explicit agent lists, so a new agent has no GitHub access and C-level policies do not cover a new executive. Run the script again after each hire. An agent with no install can fall back to `GH_TOKEN` or `GITHUB_TOKEN` company secrets, so the script reports those secrets.
- **Approved requests in flight:** an ask-first request that was created before the script ran can still execute if it is approved. Accepted risk. Owner: Salil. Trigger: each apply. Decline open requests from C-level agents before you run the script, or wait for the 60-minute approval window to end.
- **Agent classification:** C-level means role `ceo`, `cto`, `cmo` or `cfo`, a title of `Chief ... Officer`, or a name like `COO`. Engineering means a role with `engineer` or `devops`, or `qa`. Check both lists in the `--dry-run` output before you apply.
- **Board reporting:** if C-level agents post to Slack through a tool connection, the block stops it until `BOARD_REPORT_TOOLS` names those tools. Use the dry-run output to find them.
- **Routines assigned to C-level agents** can fail after the block. The script lists them but does not reassign them.
- **Gmail and Calendar writes** are blocked for C-level agents. "Write only to Google Drive" is read literally.

## Not built: cluster access

Agents run as child processes inside the `bionic-org` container and share one identity. `bionic-org-sa` is not a per-agent identity, and `paperclip-agent-web-sa` does not automount a token. Per-agent cluster access needs its own design.
